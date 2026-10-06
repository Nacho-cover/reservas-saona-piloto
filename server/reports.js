// Informes descargables del panel de personal — el equivalente a "Informes" de
// CoverManager (Reservas y Clientes), calculados sobre nuestras propias reservas.
//
//   GET /api/reports                    → catálogo (para pintar la página)
//   GET /api/reports/:id?restaurantId=… → { title, columns, rows } (JSON)
//       restaurantId: id de un local, o "all" para todos los locales
//       from / to:    rango de fechas (YYYY-MM-DD), por defecto el mes en curso
//       dateType:     "reserva" (día de la reserva, por defecto) o "anotacion"
//                     (día en que se hizo la reserva)
//       status:       solo para "Tracking de reservas" (ver STATUS_FILTERS)
//       hours:        solo para "Canceladas dentro de las X horas antes"
//       split:        solo para "Estados de las reservas por hora" (p. ej. 17:00)
//
// La página (admin/informes.html) convierte el JSON en CSV, Excel o tabla en el
// propio navegador, así que el servidor no necesita librerías de hojas de cálculo.
// Todas las rutas exigen sesión del panel (incluyen nombres y teléfonos de clientes).

const express = require('express');
const dayjs = require('dayjs');
const db = require('./db');
const { requireAdminAuth } = require('./adminAuth');

const router = express.Router();
router.use(requireAdminAuth);

// --- Expresiones SQL compartidas --------------------------------------------

// created_at / cancelled_at se guardan con la hora del servidor de base de datos
// (UTC en Supabase); en los informes se muestran en hora de España.
const LOCAL_TS = col => `(NULLIF(${col}, '')::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid')`;

// Turno de la reserva según el horario semanal del local (tabla shifts). Si la hora
// no cae dentro de ningún turno configurado, antes de las 17:00 cuenta como Comida.
const TURNO_SQL = `COALESCE(
  (SELECT s.name FROM shifts s
    WHERE s.restaurant_id = r.restaurant_id
      AND s.day_of_week = EXTRACT(DOW FROM r.date::date)
      AND r.time >= s.start_time AND r.time <= s.end_time
    ORDER BY s.start_time LIMIT 1),
  CASE WHEN r.time < '17:00' THEN 'Comida' ELSE 'Cena' END)`;

const ESTADO_SQL = `CASE r.status
  WHEN 'confirmed' THEN 'Confirmada'
  WHEN 'seated' THEN 'Sentada'
  WHEN 'eating' THEN 'Comiendo'
  WHEN 'dessert' THEN 'Postre'
  WHEN 'paid' THEN 'Pagada'
  WHEN 'completed' THEN 'Completada'
  WHEN 'cancelled' THEN CASE r.cancelled_by WHEN 'customer' THEN 'Cancelada por cliente'
                                            WHEN 'restaurant' THEN 'Cancelada por restaurante'
                                            ELSE 'Cancelada' END
  WHEN 'no_show' THEN 'No show'
  ELSE r.status END`;

const CANAL_SQL = `CASE r.source
  WHEN 'web' THEN 'Web' WHEN 'app' THEN 'App'
  WHEN 'phone' THEN 'Teléfono' WHEN 'admin' THEN 'Panel'
  ELSE r.source END`;

// Reservas que "fueron" (el cliente llegó a sentarse).
const FUERON = `('seated','eating','dessert','paid','completed')`;
// Reservas vivas (no canceladas ni no show) — las que cuentan para aforo.
const VIVAS = `r.status NOT IN ('cancelled','no_show')`;

const STATUS_FILTERS = {
  todas: { label: 'Todas', sql: null },
  confirmadas: { label: 'Confirmadas (pendientes de llegar)', sql: `r.status = 'confirmed'` },
  fueron: { label: 'Todos los que fueron', sql: `r.status IN ${FUERON}` },
  vivas: { label: 'Todas excepto canceladas y no show', sql: VIVAS },
  canceladas: { label: 'Canceladas por el cliente + restaurante', sql: `r.status = 'cancelled'` },
  canceladas_cliente: { label: 'Canceladas por cliente', sql: `r.status = 'cancelled' AND r.cancelled_by = 'customer'` },
  canceladas_restaurante: { label: 'Canceladas por restaurante', sql: `r.status = 'cancelled' AND r.cancelled_by = 'restaurant'` },
  no_show: { label: 'No show', sql: `r.status = 'no_show'` },
  web: { label: 'Reservas hechas desde la web / app', sql: `r.source IN ('web','app')` },
  telefono: { label: 'Reservas hechas desde el panel (teléfono)', sql: `r.source IN ('phone','admin')` },
};

// --- Contexto de cada petición ------------------------------------------------

function parseContext(q) {
  const all = q.restaurantId === 'all';
  const restaurantId = all ? null : Number(q.restaurantId || 1);
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const from = isDate(q.from) ? q.from : dayjs().startOf('month').format('YYYY-MM-DD');
  const to = isDate(q.to) ? q.to : dayjs().endOf('month').format('YYYY-MM-DD');
  const dateType = q.dateType === 'anotacion' ? 'anotacion' : 'reserva';
  const status = STATUS_FILTERS[q.status] ? q.status : 'todas';
  const hours = Math.min(Math.max(Number(q.hours) || 24, 1), 24 * 30);
  const split = /^\d{1,2}:\d{2}$/.test(q.split || '') ? q.split.padStart(5, '0') : null;
  return { all, restaurantId, from, to, dateType, status, hours, split };
}

// CTE "base": las reservas del ámbito pedido (local o todos, rango de fechas) con
// los campos ya calculados que usan casi todos los informes.
function baseCte(ctx, { applyStatus = false } = {}) {
  const params = [ctx.restaurantId, ctx.from, ctx.to];
  const dateExpr = ctx.dateType === 'anotacion'
    ? `to_char(${LOCAL_TS('r.created_at')}, 'YYYY-MM-DD')`
    : 'r.date';
  const statusSql = applyStatus && STATUS_FILTERS[ctx.status].sql ? `AND ${STATUS_FILTERS[ctx.status].sql}` : '';
  const sql = `
    WITH base AS (
      SELECT r.*, rest.name AS local,
             ${TURNO_SQL} AS turno,
             ${ESTADO_SQL} AS estado,
             ${CANAL_SQL} AS canal,
             ${LOCAL_TS('r.created_at')} AS anotada,
             ${LOCAL_TS('r.cancelled_at')} AS cancelada_en,
             (r.date || ' ' || r.time)::timestamp AS inicio
        FROM reservations r
        JOIN restaurants rest ON rest.id = r.restaurant_id
       WHERE ($1::int IS NULL OR r.restaurant_id = $1)
         AND ${dateExpr} BETWEEN $2 AND $3
         ${statusSql}
    )`;
  return { sql, params };
}

// Ejecuta una consulta y devuelve { columns, rows } respetando el orden de los alias.
async function run(sql, params) {
  const res = await db.query(sql, params);
  const columns = res.fields.map(f => f.name);
  return { columns, rows: res.rows.map(o => columns.map(c => o[c])) };
}

// Mesas y zona de cada reserva (en una sola cadena) para los listados.
const MESAS_SQL = `(SELECT string_agg(t.name, '+' ORDER BY t.name) FROM reservation_tables rt
                     JOIN tables t ON t.id = rt.table_id WHERE rt.reservation_id = b.id)`;
const ZONA_SQL = `(SELECT string_agg(DISTINCT z.name, ', ') FROM reservation_tables rt
                    JOIN tables t ON t.id = rt.table_id JOIN zones z ON z.id = t.zone_id
                   WHERE rt.reservation_id = b.id)`;
const FMT_TS = col => `to_char(${col}, 'YYYY-MM-DD HH24:MI')`;

// --- País del cliente a partir del prefijo del teléfono ----------------------
const PREFIJOS = [
  ['351', 'Portugal'], ['353', 'Irlanda'], ['212', 'Marruecos'], ['593', 'Ecuador'],
  ['34', 'España'], ['33', 'Francia'], ['44', 'Reino Unido'], ['49', 'Alemania'], ['39', 'Italia'],
  ['31', 'Países Bajos'], ['32', 'Bélgica'], ['41', 'Suiza'], ['43', 'Austria'], ['45', 'Dinamarca'],
  ['46', 'Suecia'], ['47', 'Noruega'], ['48', 'Polonia'], ['40', 'Rumanía'], ['52', 'México'],
  ['54', 'Argentina'], ['56', 'Chile'], ['57', 'Colombia'], ['58', 'Venezuela'], ['51', 'Perú'],
  ['55', 'Brasil'], ['86', 'China'], ['81', 'Japón'], ['7', 'Rusia'], ['1', 'EE. UU. / Canadá'],
];
function paisPorTelefono(phone) {
  if (!phone) return 'Sin teléfono';
  let p = String(phone).replace(/[^\d+]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) {
    // Número nacional sin prefijo: 9 cifras empezando por 6, 7, 8 o 9 → España.
    return /^[6789]\d{8}$/.test(p) ? 'España' : 'Desconocido';
  }
  const digits = p.slice(1);
  const hit = PREFIJOS.find(([pre]) => digits.startsWith(pre));
  return hit ? hit[1] : 'Otros';
}

// --- Catálogo de informes ------------------------------------------------------
// params: qué filtros extra usa cada informe (la página solo muestra esos).
// sheet: nombre corto de la hoja en el Excel (máx. 31 caracteres).

const REPORTS = [
  // ---------------- Reservas ----------------
  {
    id: 'tracking', sheet: 'Tracking', group: 'Reservas', title: 'Tracking de reservas',
    description: 'Listado completo de reservas con estado, canal, mesas y zona. Se puede filtrar por estado.',
    params: ['status', 'dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx, { applyStatus: true });
      return run(`${sql}
        SELECT b.local AS "Local", b.date AS "Fecha", b.time AS "Hora", b.turno AS "Turno",
               b.customer_name AS "Nombre", b.phone AS "Teléfono", b.email AS "Email",
               b.party_size AS "Pax", b.estado AS "Estado", b.canal AS "Canal",
               ${MESAS_SQL} AS "Mesas", ${ZONA_SQL} AS "Zona", b.notes AS "Notas",
               ${FMT_TS('b.anotada')} AS "Fecha de anotación", ${FMT_TS('b.cancelada_en')} AS "Fecha de cancelación"
          FROM base b ORDER BY b.local, b.date, b.time`, params);
    },
  },
  {
    id: 'valoraciones', sheet: 'Valoraciones', group: 'Reservas', title: 'Valoración de clientes',
    description: 'Respuestas a la encuesta de satisfacción del día después, una por reserva.',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      return run(`${sql}
        SELECT b.local AS "Local", b.date AS "Fecha reserva", b.turno AS "Turno",
               b.customer_name AS "Nombre", b.party_size AS "Pax",
               sr.rating_general AS "General", sr.rating_comida AS "Comida", sr.rating_servicio AS "Servicio",
               sr.comentario AS "Comentario", sr.created_at AS "Respondida"
          FROM base b JOIN survey_responses sr ON sr.reservation_id = b.id
         ORDER BY b.local, b.date`, params);
    },
  },
  {
    id: 'resumen_valoraciones', sheet: 'Resumen valoraciones', group: 'Reservas', title: 'Resumen de valoraciones',
    description: 'Nota media de la encuesta (general, comida y servicio) por local.',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      return run(`${sql}
        SELECT b.local AS "Local",
               COUNT(DISTINCT b.id) FILTER (WHERE b.survey_sent_at IS NOT NULL)::int AS "Encuestas enviadas",
               COUNT(sr.id)::int AS "Respuestas",
               ROUND(AVG(sr.rating_general), 2) AS "Media general",
               ROUND(AVG(sr.rating_comida), 2) AS "Media comida",
               ROUND(AVG(sr.rating_servicio), 2) AS "Media servicio"
          FROM base b LEFT JOIN survey_responses sr ON sr.reservation_id = b.id
         GROUP BY b.local ORDER BY b.local`, params);
    },
  },
  {
    id: 'canceladas_horas', sheet: 'Canceladas X horas antes', group: 'Reservas', title: 'Reservas canceladas dentro de las X horas antes de su reserva',
    description: 'Cancelaciones hechas con poca antelación. Solo cuenta cancelaciones registradas desde que existe este informe (antes no se guardaba la hora de cancelación).',
    params: ['hours', 'dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      return run(`${sql}
        SELECT b.local AS "Local", b.date AS "Fecha", b.time AS "Hora", b.turno AS "Turno",
               b.customer_name AS "Nombre", b.phone AS "Teléfono", b.party_size AS "Pax",
               b.estado AS "Estado", ${FMT_TS('b.cancelada_en')} AS "Cancelada el",
               ROUND(EXTRACT(EPOCH FROM (b.inicio - b.cancelada_en)) / 3600.0, 1) AS "Horas de antelación"
          FROM base b
         WHERE b.status = 'cancelled' AND b.cancelada_en IS NOT NULL
           AND b.inicio - b.cancelada_en <= make_interval(hours => $4)
         ORDER BY b.local, b.date, b.time`, [...params, ctx.hours]);
    },
  },
  {
    id: 'personas_turno_dia', sheet: 'Personas por turno y día', group: 'Reservas', title: 'Número de personas por turno y por día',
    description: 'Reservas y comensales de cada turno (sin canceladas ni no show).',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      return run(`${sql}
        SELECT b.local AS "Local", b.date AS "Fecha", b.turno AS "Turno",
               COUNT(*)::int AS "Reservas", SUM(b.party_size)::int AS "Personas"
          FROM base b WHERE b.status NOT IN ('cancelled','no_show')
         GROUP BY b.local, b.date, b.turno ORDER BY b.local, b.date, b.turno DESC`, params);
    },
  },
  {
    id: 'reservas_por_canal', sheet: 'Reservas por canal', group: 'Reservas', title: 'Número de reservas por canal',
    description: 'De dónde vienen las reservas: web, app o teléfono (anotadas en el panel). Equivale a "reservas hechas por usuario" de Cover.',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      return run(`${sql}
        SELECT b.local AS "Local", b.canal AS "Canal",
               COUNT(*)::int AS "Reservas", SUM(b.party_size)::int AS "Personas",
               COUNT(*) FILTER (WHERE b.status = 'cancelled')::int AS "Canceladas",
               COUNT(*) FILTER (WHERE b.status = 'no_show')::int AS "No show"
          FROM base b GROUP BY b.local, b.canal ORDER BY b.local, b.canal`, params);
    },
  },
  {
    id: 'resumen_grupo', sheet: 'Resumen grupo', group: 'Reservas', title: 'Resumen de reservas del grupo',
    description: 'Una fila por local: reservas, personas, cancelaciones, no show y tamaño medio de mesa.',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      return run(`${sql}
        SELECT b.local AS "Local",
               COUNT(*)::int AS "Reservas totales",
               COUNT(*) FILTER (WHERE ${VIVAS.replace(/r\./g, 'b.')})::int AS "Reservas válidas",
               COALESCE(SUM(b.party_size) FILTER (WHERE ${VIVAS.replace(/r\./g, 'b.')}), 0)::int AS "Personas",
               COUNT(*) FILTER (WHERE b.status IN ${FUERON})::int AS "Fueron",
               COUNT(*) FILTER (WHERE b.status = 'cancelled' AND b.cancelled_by = 'customer')::int AS "Canceladas cliente",
               COUNT(*) FILTER (WHERE b.status = 'cancelled' AND b.cancelled_by = 'restaurant')::int AS "Canceladas restaurante",
               COUNT(*) FILTER (WHERE b.status = 'no_show')::int AS "No show",
               ROUND(100.0 * COUNT(*) FILTER (WHERE b.status = 'no_show') / NULLIF(COUNT(*), 0), 1) AS "% No show",
               ROUND(AVG(b.party_size) FILTER (WHERE ${VIVAS.replace(/r\./g, 'b.')}), 2) AS "Pax medio"
          FROM base b GROUP BY b.local ORDER BY b.local`, params);
    },
  },
  {
    id: 'resumen_hoy_manana', sheet: 'Hoy y mañana', group: 'Reservas', title: 'Resumen de reservas del grupo por turnos (hoy/mañana)',
    description: 'Personas reservadas hoy y mañana en cada turno. No usa el rango de fechas.',
    params: [],
    async run(ctx) {
      const today = dayjs().format('YYYY-MM-DD');
      const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
      const { sql, params } = baseCte({ ...ctx, from: today, to: tomorrow, dateType: 'reserva' });
      return run(`${sql}
        SELECT b.local AS "Local",
               COALESCE(SUM(b.party_size) FILTER (WHERE b.date = $2 AND b.turno = 'Comida'), 0)::int AS "Hoy comida",
               COALESCE(SUM(b.party_size) FILTER (WHERE b.date = $2 AND b.turno = 'Cena'), 0)::int AS "Hoy cena",
               COALESCE(SUM(b.party_size) FILTER (WHERE b.date = $3 AND b.turno = 'Comida'), 0)::int AS "Mañana comida",
               COALESCE(SUM(b.party_size) FILTER (WHERE b.date = $3 AND b.turno = 'Cena'), 0)::int AS "Mañana cena"
          FROM base b WHERE b.status NOT IN ('cancelled','no_show')
         GROUP BY b.local ORDER BY b.local`, params);
    },
  },
  {
    id: 'reservas_por_hora', sheet: 'Reservas por hora', group: 'Reservas', title: 'Reservas hechas por hora',
    description: 'A qué hora del día hacen los clientes sus reservas (hora de anotación).',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      return run(`${sql}
        SELECT b.local AS "Local", to_char(b.anotada, 'HH24') || ':00' AS "Hora de anotación",
               COUNT(*)::int AS "Reservas", SUM(b.party_size)::int AS "Personas"
          FROM base b WHERE b.anotada IS NOT NULL
         GROUP BY 1, 2 ORDER BY 1, 2`, params);
    },
  },
  {
    id: 'estados_por_hora', sheet: 'Estados por hora', group: 'Reservas', title: 'Estados de las reservas por hora (pax)',
    description: 'Comensales por hora de la reserva y estado. Opcional: indica una hora de corte (p. ej. 17:00) para separar antes/después.',
    params: ['split', 'dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      const tramo = ctx.split
        ? `CASE WHEN b.time < '${ctx.split}' THEN 'Antes de ${ctx.split}' ELSE 'Desde ${ctx.split}' END`
        : `substring(b.time, 1, 2) || ':00'`;
      return run(`${sql}
        SELECT b.local AS "Local", ${tramo} AS "Hora",
               COALESCE(SUM(b.party_size) FILTER (WHERE b.status = 'confirmed'), 0)::int AS "Confirmadas",
               COALESCE(SUM(b.party_size) FILTER (WHERE b.status IN ${FUERON}), 0)::int AS "Fueron",
               COALESCE(SUM(b.party_size) FILTER (WHERE b.status = 'cancelled'), 0)::int AS "Canceladas",
               COALESCE(SUM(b.party_size) FILTER (WHERE b.status = 'no_show'), 0)::int AS "No show",
               SUM(b.party_size)::int AS "Total"
          FROM base b GROUP BY 1, 2 ORDER BY 1, 2`, params);
    },
  },
  {
    id: 'pickup', sheet: 'Pick up', group: 'Reservas', title: 'Informe pick up (antelación de las reservas)',
    description: 'Para cada día de servicio, cuántas personas reservaron el mismo día, 1-3, 4-7, 8-14 o 15+ días antes.',
    params: [],
    async run(ctx) {
      const { sql, params } = baseCte({ ...ctx, dateType: 'reserva' });
      const dias = `(b.date::date - b.anotada::date)`;
      return run(`${sql}
        SELECT b.local AS "Local", b.date AS "Fecha de servicio",
               SUM(b.party_size)::int AS "Personas",
               COALESCE(SUM(b.party_size) FILTER (WHERE ${dias} <= 0), 0)::int AS "Mismo día",
               COALESCE(SUM(b.party_size) FILTER (WHERE ${dias} BETWEEN 1 AND 3), 0)::int AS "1-3 días antes",
               COALESCE(SUM(b.party_size) FILTER (WHERE ${dias} BETWEEN 4 AND 7), 0)::int AS "4-7 días antes",
               COALESCE(SUM(b.party_size) FILTER (WHERE ${dias} BETWEEN 8 AND 14), 0)::int AS "8-14 días antes",
               COALESCE(SUM(b.party_size) FILTER (WHERE ${dias} >= 15), 0)::int AS "15+ días antes"
          FROM base b WHERE b.status NOT IN ('cancelled','no_show') AND b.anotada IS NOT NULL
         GROUP BY b.local, b.date ORDER BY b.local, b.date`, params);
    },
  },
  {
    id: 'grupo_reservas', sheet: 'Grupo - Reservas', group: 'Reservas', title: 'Reservas del grupo — Reservas',
    description: 'Tabla de locales × días con el número de reservas (sin canceladas ni no show).',
    params: ['dateType'],
    run: ctx => matrix(ctx, 'COUNT(*)'),
  },
  {
    id: 'grupo_personas', sheet: 'Grupo - Personas', group: 'Reservas', title: 'Reservas del grupo — Personas',
    description: 'Tabla de locales × días con el número de comensales (sin canceladas ni no show).',
    params: ['dateType'],
    run: ctx => matrix(ctx, 'SUM(b.party_size)'),
  },
  {
    id: 'por_zona', sheet: 'Por zona', group: 'Reservas', title: 'Número de personas/reservas por zona del restaurante',
    description: 'Reservas y comensales por zona (Sala, Barra, Terraza…) según la mesa asignada.',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      return run(`${sql},
        por_reserva AS (
          SELECT b.id, b.local, b.party_size,
                 COALESCE((SELECT string_agg(DISTINCT z.name, ', ') FROM reservation_tables rt
                             JOIN tables t ON t.id = rt.table_id JOIN zones z ON z.id = t.zone_id
                            WHERE rt.reservation_id = b.id), 'Sin zona') AS zona
            FROM base b WHERE b.status NOT IN ('cancelled','no_show'))
        SELECT local AS "Local", zona AS "Zona", COUNT(*)::int AS "Reservas", SUM(party_size)::int AS "Personas"
          FROM por_reserva GROUP BY local, zona ORDER BY local, zona`, params);
    },
  },
  {
    id: 'estados_por_dia', sheet: 'Estados por día', group: 'Reservas', title: 'Estados de reservas por días',
    description: 'Para cada día: reservas confirmadas, que fueron, canceladas y no show.',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      return run(`${sql}
        SELECT b.local AS "Local", b.date AS "Fecha",
               COUNT(*) FILTER (WHERE b.status = 'confirmed')::int AS "Confirmadas",
               COUNT(*) FILTER (WHERE b.status IN ${FUERON})::int AS "Fueron",
               COUNT(*) FILTER (WHERE b.status = 'cancelled' AND b.cancelled_by = 'customer')::int AS "Canceladas cliente",
               COUNT(*) FILTER (WHERE b.status = 'cancelled' AND COALESCE(b.cancelled_by, '') <> 'customer')::int AS "Canceladas restaurante",
               COUNT(*) FILTER (WHERE b.status = 'no_show')::int AS "No show",
               COUNT(*)::int AS "Total"
          FROM base b GROUP BY b.local, b.date ORDER BY b.local, b.date`, params);
    },
  },
  {
    id: 'ocupacion', sheet: 'Ocupación', group: 'Reservas', title: 'Disponibilidades (ocupación por turno)',
    description: 'Comensales reservados en cada turno frente al aforo del plano que usa ese turno.',
    params: [],
    async run(ctx) {
      const { sql, params } = baseCte({ ...ctx, dateType: 'reserva' });
      // Aforo: suma de comensales máximos de las mesas activas del plano que aplica
      // a ese turno (agenda de planos, plano del turno o, si no hay, el plano por defecto).
      return run(`${sql},
        turnos AS (
          SELECT b.restaurant_id, b.local, b.date, b.turno,
                 COUNT(*)::int AS reservas, SUM(b.party_size)::int AS personas
            FROM base b WHERE b.status NOT IN ('cancelled','no_show')
           GROUP BY 1, 2, 3, 4)
        SELECT t.local AS "Local", t.date AS "Fecha", t.turno AS "Turno",
               t.reservas AS "Reservas", t.personas AS "Personas",
               aforo.total AS "Aforo del plano",
               ROUND(100.0 * t.personas / NULLIF(aforo.total, 0), 1) AS "% sobre aforo"
          FROM turnos t
          LEFT JOIN LATERAL (
            SELECT SUM(tb.capacity_max)::int AS total FROM tables tb
             WHERE tb.active = 1 AND tb.floor_plan_id = COALESCE(
               (SELECT fps.floor_plan_id FROM floor_plan_schedule fps
                 WHERE fps.restaurant_id = t.restaurant_id AND fps.date = t.date),
               (SELECT s.floor_plan_id FROM shifts s
                 WHERE s.restaurant_id = t.restaurant_id AND s.name = t.turno
                   AND s.day_of_week = EXTRACT(DOW FROM t.date::date) LIMIT 1),
               (SELECT fp.id FROM floor_plans fp WHERE fp.restaurant_id = t.restaurant_id AND fp.is_default = 1 LIMIT 1))
          ) aforo ON true
         ORDER BY t.local, t.date, t.turno DESC`, params);
    },
  },
  {
    id: 'antelacion_media', sheet: 'Antelación media', group: 'Reservas', title: 'Media de antelación con la que los clientes reservan',
    description: 'Días de antelación medios por local: total, fin de semana (vie-dom), entre semana, comida y cena.',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      const dias = `EXTRACT(EPOCH FROM (b.inicio - b.anotada)) / 86400.0`;
      const finde = `EXTRACT(DOW FROM b.date::date) IN (0, 5, 6)`;
      return run(`${sql}
        SELECT b.local AS "Local", COUNT(*)::int AS "Reservas",
               ROUND(AVG(${dias})::numeric, 1) AS "Media (días)",
               ROUND((AVG(${dias}) FILTER (WHERE ${finde}))::numeric, 1) AS "Fin de semana",
               ROUND((AVG(${dias}) FILTER (WHERE NOT ${finde}))::numeric, 1) AS "Entre semana",
               ROUND((AVG(${dias}) FILTER (WHERE b.turno = 'Comida'))::numeric, 1) AS "Comida",
               ROUND((AVG(${dias}) FILTER (WHERE b.turno = 'Cena'))::numeric, 1) AS "Cena"
          FROM base b WHERE b.anotada IS NOT NULL AND b.status <> 'cancelled'
         GROUP BY b.local ORDER BY b.local`, params);
    },
  },
  {
    id: 'cancelaciones', sheet: 'Cancelaciones', group: 'Reservas', title: 'Cancelaciones de reservas',
    description: 'Todas las reservas canceladas, quién las canceló y cuándo.',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      return run(`${sql}
        SELECT b.local AS "Local", b.date AS "Fecha", b.time AS "Hora", b.turno AS "Turno",
               b.customer_name AS "Nombre", b.phone AS "Teléfono", b.party_size AS "Pax",
               CASE b.cancelled_by WHEN 'customer' THEN 'Cliente' WHEN 'restaurant' THEN 'Restaurante' ELSE '—' END AS "Cancelada por",
               b.canal AS "Canal", ${FMT_TS('b.anotada')} AS "Anotada el", ${FMT_TS('b.cancelada_en')} AS "Cancelada el"
          FROM base b WHERE b.status = 'cancelled'
         ORDER BY b.local, b.date, b.time`, params);
    },
  },
  {
    id: 'cierres', sheet: 'Cierres', group: 'Reservas', title: 'Listado de cierres (días y turnos bloqueados)',
    description: 'Días o turnos cerrados a reservas en el periodo. Equivale a "mesas bloqueadas" de Cover.',
    params: [],
    async run(ctx) {
      return run(`
        SELECT rest.name AS "Local", c.date AS "Fecha", COALESCE(c.shift, 'Día completo') AS "Turno", c.note AS "Nota"
          FROM closures c JOIN restaurants rest ON rest.id = c.restaurant_id
         WHERE ($1::int IS NULL OR c.restaurant_id = $1) AND c.date BETWEEN $2 AND $3
         ORDER BY rest.name, c.date`, [ctx.restaurantId, ctx.from, ctx.to]);
    },
  },

  // ---------------- Clientes ----------------
  {
    id: 'clientes', sheet: 'Clientes', group: 'Clientes', title: 'Listado de clientes',
    description: 'Ficha de cada cliente: contacto, visitas y su actividad en el periodo elegido.',
    params: [],
    async run(ctx) {
      return run(`
        SELECT rest.name AS "Local", c.name AS "Nombre", c.phone AS "Teléfono", c.email AS "Email",
               c.visits AS "Visitas (histórico)",
               COUNT(r.id) FILTER (WHERE r.date BETWEEN $2 AND $3)::int AS "Reservas en el periodo",
               COALESCE(SUM(r.party_size) FILTER (WHERE r.date BETWEEN $2 AND $3 AND ${VIVAS}), 0)::int AS "Personas en el periodo",
               COUNT(r.id) FILTER (WHERE r.status = 'no_show')::int AS "No show (histórico)",
               MAX(r.date) AS "Última reserva", c.notes AS "Notas"
          FROM customers c
          JOIN restaurants rest ON rest.id = c.restaurant_id
          LEFT JOIN reservations r ON r.customer_id = c.id
         WHERE ($1::int IS NULL OR c.restaurant_id = $1)
         GROUP BY rest.name, c.id ORDER BY rest.name, c.name`, [ctx.restaurantId, ctx.from, ctx.to]);
    },
  },
  {
    id: 'mejores_clientes', sheet: 'Mejores clientes', group: 'Clientes', title: 'Mejores clientes',
    description: 'Los 100 clientes con más reservas (que no se cancelaron) en el periodo.',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      return run(`${sql}
        SELECT b.local AS "Local", MAX(b.customer_name) AS "Nombre", b.phone AS "Teléfono", MAX(b.email) AS "Email",
               COUNT(*)::int AS "Reservas", SUM(b.party_size)::int AS "Personas",
               COUNT(*) FILTER (WHERE b.status = 'no_show')::int AS "No show",
               MAX(b.date) AS "Última reserva"
          FROM base b WHERE b.status <> 'cancelled' AND b.phone IS NOT NULL
         GROUP BY b.local, b.phone
         ORDER BY COUNT(*) DESC, SUM(b.party_size) DESC LIMIT 100`, params);
    },
  },
  {
    id: 'origen_clientes', sheet: 'Origen clientes', group: 'Clientes', title: 'De dónde son tus clientes',
    description: 'País de los clientes que reservaron en el periodo, según el prefijo de su teléfono.',
    params: ['dateType'],
    async run(ctx) {
      const { sql, params } = baseCte(ctx);
      const { rows } = await db.query(`${sql}
        SELECT b.local, b.phone, b.party_size FROM base b WHERE b.status <> 'cancelled'`, params);
      const agg = new Map();
      for (const r of rows) {
        const key = `${r.local}\u0000${paisPorTelefono(r.phone)}`;
        const a = agg.get(key) || { reservas: 0, personas: 0 };
        a.reservas += 1; a.personas += r.party_size;
        agg.set(key, a);
      }
      const out = [...agg.entries()].map(([k, a]) => [...k.split('\u0000'), a.reservas, a.personas])
        .sort((x, y) => x[0].localeCompare(y[0], 'es') || y[2] - x[2]);
      return { columns: ['Local', 'País', 'Reservas', 'Personas'], rows: out };
    },
  },
];

// Informes de Cover que todavía no se pueden replicar porque la app no guarda esos datos.
const NOT_AVAILABLE = [
  { title: 'Productos vendidos / Gestión de cobros / Pagos', reason: 'La app aún no cobra prepagos ni vende productos.' },
  { title: 'Lista de espera', reason: 'La app aún no tiene lista de espera.' },
  { title: 'Reservas agrupadas por etiquetas', reason: 'Las reservas aún no llevan etiquetas.' },
  { title: 'Número de reservas por prescriptores', reason: 'No hay prescriptores ni campañas.' },
  { title: 'Resumen de clicks en valoraciones externas', reason: 'La encuesta no enlaza todavía a Google/TripAdvisor.' },
  { title: 'Reservas hechas por usuario', reason: 'El panel usa un único usuario compartido; se sustituye por "reservas por canal".' },
];

// Locales × días (para "Reservas del grupo").
async function matrix(ctx, aggSql) {
  const { sql, params } = baseCte(ctx);
  const { rows } = await db.query(`${sql}
    SELECT b.local, ${ctx.dateType === 'anotacion' ? "to_char(b.anotada, 'YYYY-MM-DD')" : 'b.date'} AS dia,
           (${aggSql})::int AS v
      FROM base b WHERE b.status NOT IN ('cancelled','no_show') GROUP BY 1, 2`, params);
  const days = [];
  for (let d = dayjs(ctx.from); !d.isAfter(dayjs(ctx.to)) && days.length < 400; d = d.add(1, 'day')) {
    days.push(d.format('YYYY-MM-DD'));
  }
  const byLocal = new Map();
  for (const r of rows) {
    if (!byLocal.has(r.local)) byLocal.set(r.local, {});
    byLocal.get(r.local)[r.dia] = r.v;
  }
  const out = [...byLocal.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([local, vals]) => {
    const cells = days.map(d => vals[d] || 0);
    return [local, ...cells, cells.reduce((s, n) => s + n, 0)];
  });
  return { columns: ['Local', ...days.map(d => d.slice(8, 10) + '/' + d.slice(5, 7)), 'Total'], rows: out };
}

// --- Rutas -------------------------------------------------------------------

router.get('/', (req, res) => {
  res.json({
    reports: REPORTS.map(({ id, sheet, group, title, description, params }) => ({ id, sheet, group, title, description, params })),
    statusFilters: Object.entries(STATUS_FILTERS).map(([id, f]) => ({ id, label: f.label })),
    notAvailable: NOT_AVAILABLE,
  });
});

// Panel visual de la página de Informes: KPIs y series para los gráficos, con los
// mismos filtros que los informes (local o todos, rango, tipo de fecha).
router.get('/dashboard', async (req, res) => {
  const ctx = parseContext(req.query);
  if (dayjs(ctx.to).diff(dayjs(ctx.from), 'day') > 366) {
    return res.status(400).json({ error: 'El rango de fechas no puede superar un año.' });
  }
  const { sql, params } = baseCte(ctx);
  const VALIDA = `b.status NOT IN ('cancelled','no_show')`;
  const dayExpr = ctx.dateType === 'anotacion' ? "to_char(b.anotada, 'YYYY-MM-DD')" : 'b.date';
  try {
    // En serie, no en paralelo: el pooler de Supabase limita las conexiones simultáneas.
    const queries = [
      [`${sql}
        SELECT COUNT(*) FILTER (WHERE ${VALIDA})::int AS reservas,
               COALESCE(SUM(b.party_size) FILTER (WHERE ${VALIDA}), 0)::int AS personas,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE b.status = 'no_show')::int AS no_show,
               COUNT(*) FILTER (WHERE b.status = 'cancelled')::int AS canceladas,
               ROUND(AVG(b.party_size) FILTER (WHERE ${VALIDA}), 1) AS pax_medio,
               ROUND((AVG(EXTRACT(EPOCH FROM (b.inicio - b.anotada)) / 86400.0)
                 FILTER (WHERE ${VALIDA} AND b.anotada IS NOT NULL))::numeric, 1) AS antelacion
          FROM base b`, params],
      [`${sql}
        SELECT ${dayExpr} AS dia,
               COALESCE(SUM(b.party_size) FILTER (WHERE b.turno = 'Comida'), 0)::int AS comida,
               COALESCE(SUM(b.party_size) FILTER (WHERE b.turno <> 'Comida'), 0)::int AS cena
          FROM base b WHERE ${VALIDA} GROUP BY 1 ORDER BY 1`, params],
      [`${sql}
        SELECT b.canal, COUNT(*)::int AS reservas, SUM(b.party_size)::int AS personas
          FROM base b WHERE ${VALIDA} GROUP BY 1 ORDER BY 2 DESC`, params],
      [`${sql}
        SELECT substring(b.time, 1, 2) AS hora, SUM(b.party_size)::int AS personas
          FROM base b WHERE ${VALIDA} GROUP BY 1 ORDER BY 1`, params],
      [`${sql}
        SELECT b.local, COALESCE(SUM(b.party_size) FILTER (WHERE ${VALIDA}), 0)::int AS personas,
               COUNT(*) FILTER (WHERE ${VALIDA})::int AS reservas,
               ROUND(100.0 * COUNT(*) FILTER (WHERE b.status = 'no_show') / NULLIF(COUNT(*), 0), 1) AS pct_no_show
          FROM base b GROUP BY 1 ORDER BY 2 DESC`, params],
      [`${sql}
        SELECT b.estado, COUNT(*)::int AS reservas FROM base b GROUP BY 1 ORDER BY 2 DESC`, params],
    ];
    const results = [];
    for (const [q, p] of queries) results.push(await db.query(q, p));
    const [kpis, porDia, porCanal, porHora, porLocal, porEstado] = results;
    const k = kpis.rows[0];
    // Días sin reservas también aparecen en el gráfico (con 0), para no falsear la tendencia.
    const byDay = new Map(porDia.rows.map(r => [r.dia, r]));
    const dias = [];
    for (let d = dayjs(ctx.from); !d.isAfter(dayjs(ctx.to)) && dias.length < 400; d = d.add(1, 'day')) {
      const key = d.format('YYYY-MM-DD');
      const r = byDay.get(key);
      dias.push({ dia: key, comida: r ? r.comida : 0, cena: r ? r.cena : 0 });
    }
    res.json({
      from: ctx.from, to: ctx.to, all: ctx.all,
      kpis: {
        reservas: k.reservas, personas: k.personas, canceladas: k.canceladas,
        noShow: k.no_show, total: k.total,
        pctNoShow: k.total ? Math.round(1000 * k.no_show / k.total) / 10 : null,
        paxMedio: k.pax_medio != null ? Number(k.pax_medio) : null,
        antelacion: k.antelacion != null ? Number(k.antelacion) : null,
      },
      porDia: dias,
      porCanal: porCanal.rows,
      porHora: porHora.rows,
      porLocal: porLocal.rows.map(r => ({ ...r, pct_no_show: r.pct_no_show != null ? Number(r.pct_no_show) : null })),
      porEstado: porEstado.rows,
    });
  } catch (err) {
    console.error('[informes] dashboard:', err);
    res.status(500).json({ error: 'No se pudo generar el panel.' });
  }
});

router.get('/:id', async (req, res) => {
  const report = REPORTS.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Informe no encontrado' });
  const ctx = parseContext(req.query);
  if (dayjs(ctx.to).diff(dayjs(ctx.from), 'day') > 366) {
    return res.status(400).json({ error: 'El rango de fechas no puede superar un año.' });
  }
  try {
    const data = await report.run(ctx);
    res.json({ id: report.id, title: report.title, from: ctx.from, to: ctx.to, ...data });
  } catch (err) {
    console.error(`[informes] ${report.id}:`, err);
    res.status(500).json({ error: 'No se pudo generar el informe.' });
  }
});

module.exports = router;
module.exports.paisPorTelefono = paisPorTelefono;
module.exports.REPORTS = REPORTS;
