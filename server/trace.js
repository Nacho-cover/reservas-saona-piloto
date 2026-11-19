// Hoja de vida de la reserva: trazabilidad de principio a fin.
//
// Cada hecho de una reserva (creada, tarjeta o pago, mesa, recordatorio, el cliente
// confirma, sentada, completada, cancelada, no-show, penalización, encuesta, lista de
// espera, abandonada…) queda como una fila en `reservation_events`.
//
// Se apunta DESDE LA BASE DE DATOS (disparadores), no desde cada ruta del servidor: así
// se registra igual si el cambio viene de la web del cliente, del panel, del
// recordatorio, de la lista de espera, del pago o de cualquier circuito futuro. Un fallo
// al apuntar NUNCA impide la reserva (cada disparador captura sus errores).
//
// Además cada reserva guarda dos datos fijos para los informes:
//   guest_key   cliente único del grupo (teléfono normalizado; si no hay, el email)
//   shift_name  turno (Comida/Cena…) en el momento de reservar: si luego cambia el
//               horario, los informes del pasado no cambian.
//
// Las reservas que caducan sin terminar el pago o la tarjeta se siguen borrando (para no
// ocupar mesa), pero antes de borrarse dejan su rastro como «abandonada».
//
//   GET /api/trace/reservation/:id   hoja de vida de una reserva (panel, permiso reservations)

const express = require('express');

// Texto de «quién» para cada hecho cuando no se encuentra al usuario del panel.
const SISTEMA = new Set(['aviso', 'recordatorio_enviado', 'encuesta_enviada', 'abandonada', 'pago_intento',
  'lista_espera_caducada', 'mesa_asignada', 'mesa_liberada']);

const EVENT_LABELS = {
  creada: 'Reserva creada', confirmada: 'Confirmada (tarjeta o pago correcto)', reactivada: 'Reactivada',
  estado: 'Cambio de estado', cancelada: 'Cancelada', no_show: 'No show', modificada: 'Reserva modificada',
  mesa_asignada: 'Mesa asignada', mesa_liberada: 'Mesa liberada', cuenta_pagada: 'Cuenta pagada',
  recordatorio_enviado: 'Recordatorio enviado', cliente_confirma: 'El cliente confirma asistencia',
  encuesta_enviada: 'Encuesta enviada', valoracion: 'Valoración recibida', aviso: 'Aviso al cliente',
  garantia: 'Garantía con tarjeta', penalizacion: 'Penalización', pago_anticipado: 'Pago anticipado',
  pago_intento: 'Intento de pago', devolucion_pago: 'Devolución del pago',
  abandonada: 'Abandonada (no terminó el pago o la tarjeta)', eliminada: 'Reserva eliminada',
  lista_espera_alta: 'Apuntado a la lista de espera', lista_espera_offered: 'Oferta de mesa enviada',
  lista_espera_accepted: 'Aceptó la mesa de la lista de espera', lista_espera_expired: 'No contestó a tiempo',
  lista_espera_cancelled: 'Quitado de la lista de espera',
};

// --- Esquema, funciones y disparadores (idempotente; se ejecuta en cada arranque) ----------
async function init(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservation_events (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Sin clave foránea a propósito: el rastro debe sobrevivir al borrado de la reserva.
      reservation_id INTEGER,
      waitlist_id INTEGER,
      restaurant_id INTEGER,
      guest_key TEXT,
      event TEXT NOT NULL,
      from_value TEXT,
      to_value TEXT,
      channel TEXT,
      details JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_res_events_res ON reservation_events (reservation_id, at);
    CREATE INDEX IF NOT EXISTS idx_res_events_rest ON reservation_events (restaurant_id, at);
    CREATE INDEX IF NOT EXISTS idx_res_events_guest ON reservation_events (guest_key, at);
    CREATE INDEX IF NOT EXISTS idx_res_events_event ON reservation_events (event, at);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guest_key TEXT;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS shift_name TEXT;
    CREATE INDEX IF NOT EXISTS idx_reservations_guest ON reservations (guest_key);
  `);

  await pool.query(`
    -- Cliente único del grupo: teléfono normalizado (misma regla que la ficha) o, si no hay
    -- teléfono, el email en minúsculas.
    CREATE OR REPLACE FUNCTION saona_guest_key(p_phone TEXT, p_email TEXT) RETURNS TEXT
    LANGUAGE sql IMMUTABLE AS $fn$
      SELECT CASE
        WHEN length(COALESCE(saona_norm_phone(p_phone), '')) >= 6 THEN saona_norm_phone(p_phone)
        WHEN COALESCE(btrim(p_email), '') <> '' THEN 'email:' || lower(btrim(p_email))
        ELSE NULL END
    $fn$;

    -- Turno de una reserva según el horario semanal del local; si no cae en ninguno,
    -- antes de las 17:00 es Comida. Misma regla que los informes (server/reports.js).
    CREATE OR REPLACE FUNCTION saona_shift_name(p_rest INTEGER, p_date TEXT, p_time TEXT) RETURNS TEXT
    LANGUAGE plpgsql STABLE AS $fn$
    DECLARE v TEXT;
    BEGIN
      SELECT s.name INTO v FROM shifts s
       WHERE s.restaurant_id = p_rest
         AND s.day_of_week = EXTRACT(DOW FROM p_date::date)
         AND p_time >= s.start_time AND p_time <= s.end_time
       ORDER BY s.start_time LIMIT 1;
      IF v IS NULL THEN v := CASE WHEN p_time < '17:00' THEN 'Comida' ELSE 'Cena' END; END IF;
      RETURN v;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END
    $fn$;

    CREATE OR REPLACE FUNCTION saona_res_prepare() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      NEW.guest_key := saona_guest_key(NEW.phone, NEW.email);
      NEW.shift_name := saona_shift_name(NEW.restaurant_id, NEW.date, NEW.time);
      RETURN NEW;
    END
    $fn$;

    CREATE OR REPLACE FUNCTION saona_res_event_ins() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, to_value, channel, details)
      VALUES (NEW.id, NEW.restaurant_id, NEW.guest_key, 'creada', NEW.status, NEW.source,
              jsonb_build_object('nombre', NEW.customer_name, 'pax', NEW.party_size, 'fecha', NEW.date,
                                 'hora', NEW.time, 'turno', NEW.shift_name));
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'trazabilidad (creada): %', SQLERRM;
      RETURN NEW;
    END
    $fn$;

    CREATE OR REPLACE FUNCTION saona_res_event_upd() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE ev TEXT;
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        ev := CASE
          WHEN NEW.status = 'cancelled' THEN 'cancelada'
          WHEN NEW.status = 'no_show' THEN 'no_show'
          WHEN OLD.status = 'pending_card' AND NEW.status = 'confirmed' THEN 'confirmada'
          WHEN OLD.status IN ('cancelled','no_show') AND NEW.status = 'confirmed' THEN 'reactivada'
          ELSE 'estado' END;
        INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, from_value, to_value, channel, details)
        VALUES (NEW.id, NEW.restaurant_id, NEW.guest_key, ev, OLD.status, NEW.status, NEW.source,
                CASE WHEN NEW.status = 'cancelled' THEN jsonb_build_object('cancelado_por', NEW.cancelled_by) ELSE NULL END);
      END IF;
      IF NEW.party_size IS DISTINCT FROM OLD.party_size OR NEW.date IS DISTINCT FROM OLD.date
         OR NEW.time IS DISTINCT FROM OLD.time THEN
        INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, channel, details)
        VALUES (NEW.id, NEW.restaurant_id, NEW.guest_key, 'modificada', NEW.source,
                jsonb_build_object('antes', jsonb_build_object('pax', OLD.party_size, 'fecha', OLD.date, 'hora', OLD.time),
                                   'despues', jsonb_build_object('pax', NEW.party_size, 'fecha', NEW.date, 'hora', NEW.time)));
      END IF;
      IF OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL THEN
        INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, channel)
        VALUES (NEW.id, NEW.restaurant_id, NEW.guest_key, 'cuenta_pagada', NEW.source);
      END IF;
      IF OLD.reminder_sent_at IS NULL AND NEW.reminder_sent_at IS NOT NULL THEN
        INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, channel)
        VALUES (NEW.id, NEW.restaurant_id, NEW.guest_key, 'recordatorio_enviado', NEW.source);
      END IF;
      IF OLD.customer_confirmed_at IS NULL AND NEW.customer_confirmed_at IS NOT NULL THEN
        INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, channel)
        VALUES (NEW.id, NEW.restaurant_id, NEW.guest_key, 'cliente_confirma', NEW.source);
      END IF;
      IF OLD.survey_sent_at IS NULL AND NEW.survey_sent_at IS NOT NULL THEN
        INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, channel)
        VALUES (NEW.id, NEW.restaurant_id, NEW.guest_key, 'encuesta_enviada', NEW.source);
      END IF;
      IF NEW.guarantee_status IS DISTINCT FROM OLD.guarantee_status THEN
        INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, from_value, to_value, channel, details)
        VALUES (NEW.id, NEW.restaurant_id, NEW.guest_key, 'garantia', OLD.guarantee_status, NEW.guarantee_status, NEW.source,
                jsonb_build_object('tarjeta', NEW.card_last4, 'importe_cent', NEW.guarantee_fee_cents));
      END IF;
      IF NEW.penalty_status IS DISTINCT FROM OLD.penalty_status THEN
        INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, from_value, to_value, channel, details)
        VALUES (NEW.id, NEW.restaurant_id, NEW.guest_key, 'penalizacion', OLD.penalty_status, NEW.penalty_status, NEW.source,
                jsonb_build_object('importe_cent', NEW.penalty_amount_cents));
      END IF;
      IF NEW.prepay_status IS DISTINCT FROM OLD.prepay_status THEN
        INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, from_value, to_value, channel, details)
        VALUES (NEW.id, NEW.restaurant_id, NEW.guest_key, 'pago_anticipado', OLD.prepay_status, NEW.prepay_status, NEW.source,
                jsonb_build_object('importe_cent', NEW.prepay_amount_cents));
      END IF;
      IF NEW.prepay_refund_status IS DISTINCT FROM OLD.prepay_refund_status THEN
        INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, from_value, to_value, channel, details)
        VALUES (NEW.id, NEW.restaurant_id, NEW.guest_key, 'devolucion_pago', OLD.prepay_refund_status, NEW.prepay_refund_status, NEW.source,
                jsonb_build_object('importe_cent', NEW.prepay_amount_cents));
      END IF;
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'trazabilidad (cambio): %', SQLERRM;
      RETURN NEW;
    END
    $fn$;

    -- Al borrarse una reserva (las pendientes de tarjeta o pago que caducan) se guarda su rastro.
    CREATE OR REPLACE FUNCTION saona_res_event_del() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, from_value, channel, details)
      VALUES (OLD.id, OLD.restaurant_id, OLD.guest_key,
              CASE WHEN OLD.status = 'pending_card' THEN 'abandonada' ELSE 'eliminada' END,
              OLD.status, OLD.source,
              jsonb_build_object('nombre', OLD.customer_name, 'pax', OLD.party_size, 'fecha', OLD.date,
                                 'hora', OLD.time, 'turno', OLD.shift_name, 'creada', OLD.created_at,
                                 'garantia', OLD.guarantee_status, 'pago_anticipado', OLD.prepay_status));
      RETURN OLD;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'trazabilidad (borrada): %', SQLERRM;
      RETURN OLD;
    END
    $fn$;

    CREATE OR REPLACE FUNCTION saona_table_event() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE r RECORD; tname TEXT; rid INTEGER; tid INTEGER;
    BEGIN
      IF TG_OP = 'DELETE' THEN rid := OLD.reservation_id; tid := OLD.table_id;
      ELSE rid := NEW.reservation_id; tid := NEW.table_id; END IF;
      SELECT restaurant_id, guest_key, source INTO r FROM reservations WHERE id = rid;
      IF NOT FOUND THEN RETURN NULL; END IF; -- reserva ya borrada: lo cuenta su propio evento
      SELECT name INTO tname FROM tables WHERE id = tid;
      INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, to_value, channel)
      VALUES (rid, r.restaurant_id, r.guest_key,
              CASE WHEN TG_OP = 'DELETE' THEN 'mesa_liberada' ELSE 'mesa_asignada' END, tname, r.source);
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'trazabilidad (mesa): %', SQLERRM;
      RETURN NULL;
    END
    $fn$;

    CREATE OR REPLACE FUNCTION saona_notification_event() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE gk TEXT;
    BEGIN
      IF NEW.reservation_id IS NOT NULL THEN
        SELECT guest_key INTO gk FROM reservations WHERE id = NEW.reservation_id;
      ELSIF NEW.waitlist_id IS NOT NULL THEN
        SELECT saona_guest_key(phone, email) INTO gk FROM waitlist WHERE id = NEW.waitlist_id;
      END IF;
      INSERT INTO reservation_events (reservation_id, waitlist_id, restaurant_id, guest_key, event, to_value, channel, details)
      VALUES (NEW.reservation_id, NEW.waitlist_id, NEW.restaurant_id, gk, 'aviso', NEW.status, NEW.channel,
              jsonb_build_object('tipo', NEW.kind, 'destinatario', NEW.recipient, 'error', NEW.error));
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'trazabilidad (aviso): %', SQLERRM;
      RETURN NULL;
    END
    $fn$;

    CREATE OR REPLACE FUNCTION saona_waitlist_event() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO reservation_events (waitlist_id, restaurant_id, guest_key, event, to_value, channel, details)
        VALUES (NEW.id, NEW.restaurant_id, saona_guest_key(NEW.phone, NEW.email), 'lista_espera_alta', NEW.status, NEW.source,
                jsonb_build_object('nombre', NEW.customer_name, 'pax', NEW.party_size, 'fecha', NEW.date, 'hora', NEW.time));
      ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO reservation_events (reservation_id, waitlist_id, restaurant_id, guest_key, event, from_value, to_value, channel, details)
        VALUES (NEW.reservation_id, NEW.id, NEW.restaurant_id, saona_guest_key(NEW.phone, NEW.email),
                'lista_espera_' || NEW.status, OLD.status, NEW.status, NEW.source,
                jsonb_build_object('nombre', NEW.customer_name, 'pax', NEW.party_size, 'fecha', NEW.date, 'hora', NEW.time,
                                   'hora_ofrecida', NEW.offer_time));
      END IF;
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'trazabilidad (lista de espera): %', SQLERRM;
      RETURN NULL;
    END
    $fn$;

    CREATE OR REPLACE FUNCTION saona_survey_event() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE r RECORD;
    BEGIN
      SELECT restaurant_id, guest_key INTO r FROM reservations WHERE id = NEW.reservation_id;
      INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, to_value, details)
      VALUES (NEW.reservation_id, r.restaurant_id, r.guest_key, 'valoracion', NEW.rating_general::text,
              jsonb_build_object('general', NEW.rating_general, 'comida', NEW.rating_comida, 'servicio', NEW.rating_servicio));
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'trazabilidad (valoración): %', SQLERRM;
      RETURN NULL;
    END
    $fn$;

    CREATE OR REPLACE FUNCTION saona_prepay_attempt_event() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE r RECORD;
    BEGIN
      SELECT restaurant_id, guest_key INTO r FROM reservations WHERE id = NEW.reservation_id;
      INSERT INTO reservation_events (reservation_id, restaurant_id, guest_key, event, details)
      VALUES (NEW.reservation_id, r.restaurant_id, r.guest_key, 'pago_intento', jsonb_build_object('pedido', NEW.order_no));
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'trazabilidad (intento de pago): %', SQLERRM;
      RETURN NULL;
    END
    $fn$;
  `);

  // Disparadores: se recrean en cada arranque (DROP IF EXISTS + CREATE) para que cualquier
  // cambio de las funciones quede aplicado.
  const triggers = [
    ['trg_res_prepare', 'reservations', 'BEFORE INSERT OR UPDATE OF phone, email, date, time, restaurant_id', 'saona_res_prepare'],
    ['trg_res_event_ins', 'reservations', 'AFTER INSERT', 'saona_res_event_ins'],
    ['trg_res_event_upd', 'reservations', 'AFTER UPDATE', 'saona_res_event_upd'],
    ['trg_res_event_del', 'reservations', 'AFTER DELETE', 'saona_res_event_del'],
    ['trg_table_event', 'reservation_tables', 'AFTER INSERT OR DELETE', 'saona_table_event'],
    ['trg_notification_event', 'notifications', 'AFTER INSERT', 'saona_notification_event'],
    ['trg_waitlist_event', 'waitlist', 'AFTER INSERT OR UPDATE', 'saona_waitlist_event'],
    ['trg_survey_event', 'survey_responses', 'AFTER INSERT', 'saona_survey_event'],
    ['trg_prepay_attempt_event', 'prepay_attempts', 'AFTER INSERT', 'saona_prepay_attempt_event'],
  ];
  for (const [name, table, when, fn] of triggers) {
    await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await pool.query(`CREATE TRIGGER ${name} ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  }

  // Reservas anteriores a la hoja de vida: se rellenan sus datos fijos y se reconstruye lo
  // que se sabe (creada y estado actual), marcado como «reconstruido». Solo la primera vez.
  await pool.query(`
    UPDATE reservations SET guest_key = saona_guest_key(phone, email),
                            shift_name = saona_shift_name(restaurant_id, date, time)
     WHERE shift_name IS NULL;
    DO $do$
    DECLARE r RECORD;
    BEGIN
      FOR r IN SELECT * FROM reservations x
                WHERE NOT EXISTS (SELECT 1 FROM reservation_events e WHERE e.reservation_id = x.id) LOOP
        INSERT INTO reservation_events (at, reservation_id, restaurant_id, guest_key, event, to_value, channel, details)
        VALUES (COALESCE(NULLIF(r.created_at, '')::timestamp AT TIME ZONE 'UTC', now()), r.id, r.restaurant_id,
                r.guest_key, 'creada', 'confirmed', r.source,
                jsonb_build_object('nombre', r.customer_name, 'pax', r.party_size, 'fecha', r.date, 'hora', r.time,
                                   'turno', r.shift_name, 'reconstruido', true));
        IF r.status <> 'confirmed' THEN
          INSERT INTO reservation_events (at, reservation_id, restaurant_id, guest_key, event, from_value, to_value, channel, details)
          VALUES (COALESCE(NULLIF(r.cancelled_at, '')::timestamp AT TIME ZONE 'UTC', NULLIF(r.paid_at, '')::timestamp AT TIME ZONE 'UTC',
                           NULLIF(r.created_at, '')::timestamp AT TIME ZONE 'UTC', now()),
                  r.id, r.restaurant_id, r.guest_key,
                  CASE r.status WHEN 'cancelled' THEN 'cancelada' WHEN 'no_show' THEN 'no_show' ELSE 'estado' END,
                  'confirmed', r.status, r.source,
                  jsonb_build_object('reconstruido', true, 'cancelado_por', r.cancelled_by));
        END IF;
      END LOOP;
    END
    $do$;
  `);

  // Seguridad: ninguna tabla queda expuesta por la API pública de Supabase. La app entra
  // como dueño de las tablas (ignora estas reglas), así que no le afecta.
  try {
    await pool.query(`
      DO $do$
      DECLARE t RECORD;
      BEGIN
        FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
          EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
        END LOOP;
      END
      $do$;`);
  } catch (err) {
    console.error('[trazabilidad] no se pudo activar la seguridad por filas:', err.message);
  }
}

// --- Hoja de vida de una reserva ------------------------------------------------------------
function actorLabel(ev, auditEmail) {
  if (auditEmail) return auditEmail;
  const d = ev.details || {};
  if (ev.event === 'creada') return ev.channel === 'web' || ev.channel === 'app' ? 'Cliente (web)' : ev.channel === 'walkin' ? 'Panel (walk-in)' : 'Panel';
  if (ev.event === 'cancelada') return d.cancelado_por === 'customer' ? 'Cliente' : 'Restaurante';
  if (ev.event === 'cliente_confirma') return 'Cliente';
  if (SISTEMA.has(ev.event)) return 'Sistema';
  if (ev.event === 'valoracion') return 'Cliente';
  if (ev.event === 'garantia' || ev.event === 'pago_anticipado') return ['ok', 'paid'].includes(ev.to_value) ? 'Pasarela de pago' : 'Panel o cliente';
  if (ev.event === 'penalizacion' || ev.event === 'devolucion_pago') return 'Panel (persona del equipo)';
  return ev.channel === 'web' ? 'Cliente o sistema' : 'Panel o sistema';
}

function makeRouter() {
  const db = require('./db');
  const adminAuth = require('./adminAuth');
  const perms = require('./permissions');
  const router = express.Router();
  router.use(adminAuth.can('reservations'));

  router.get('/reservation/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Identificador no válido.' });
    try {
      const { rows: evs } = await db.query(
        `SELECT e.id, e.at, e.restaurant_id, e.event, e.from_value, e.to_value, e.channel, e.details, e.waitlist_id
           FROM reservation_events e WHERE e.reservation_id = $1 ORDER BY e.at, e.id`, [id]);
      const { rows: cur } = await db.query(
        `SELECT r.*, rest.name AS local FROM reservations r JOIN restaurants rest ON rest.id = r.restaurant_id WHERE r.id = $1`, [id]);
      const restaurantId = cur.length ? cur[0].restaurant_id : (evs[0] && evs[0].restaurant_id);
      if (restaurantId == null) return res.status(404).json({ error: 'No hay historial de esta reserva.' });
      if (!perms.canAccessRestaurant(req.user, restaurantId)) return res.status(403).json({ error: 'No tienes acceso a este local.' });

      // «Quién»: se cruza con el registro de Actividad (cambios hechos desde el panel).
      const { rows: who } = await db.query(
        `SELECT DISTINCT ON (e.id) e.id AS event_id, a.user_email
           FROM reservation_events e
           JOIN audit_log a ON a.restaurant_id = e.restaurant_id
            AND a.user_email IS NOT NULL
            AND a.at BETWEEN e.at - interval '5 seconds' AND e.at + interval '15 seconds'
            AND ((a.summary LIKE 'Reserva #' || e.reservation_id || ' %'
                  AND e.event NOT IN ('creada','recordatorio_enviado','cliente_confirma','encuesta_enviada','valoracion',
                                      'aviso','abandonada','eliminada','garantia','pago_intento','mesa_asignada','mesa_liberada'))
                 OR (e.event IN ('mesa_asignada','mesa_liberada') AND a.action = 'reserva.mover'
                     AND a.summary LIKE 'Reserva #' || e.reservation_id || ' %')
                 OR (e.event = 'creada' AND a.action = 'reserva.crear' AND e.channel IN ('phone','admin','walkin')
                     AND a.summary ILIKE '%' || COALESCE(e.details->>'nombre', '') || '%')
                 OR (e.event IN ('mesa_asignada','mesa_liberada') AND a.action = 'reserva.crear'
                     AND e.channel IN ('phone','admin','walkin'))
                 OR (e.event IN ('mesa_asignada','mesa_liberada') AND a.action = 'reserva.intercambiar'
                     AND (a.summary LIKE '%#' || e.reservation_id || ' %' OR a.summary LIKE '%#' || e.reservation_id)))
          WHERE e.reservation_id = $1
          ORDER BY e.id, abs(extract(epoch FROM (a.at - e.at)))`, [id]);
      const whoBy = new Map(who.map(w => [String(w.event_id), w.user_email]));

      res.json({
        reservation: cur[0] ? {
          id: cur[0].id, local: cur[0].local, nombre: cur[0].customer_name, pax: cur[0].party_size,
          fecha: cur[0].date, hora: cur[0].time, turno: cur[0].shift_name, estado: cur[0].status, canal: cur[0].source,
        } : { id, eliminada: true },
        events: evs.map(e => ({
          id: String(e.id), at: e.at, event: e.event, label: EVENT_LABELS[e.event] || e.event,
          from: e.from_value, to: e.to_value, channel: e.channel, details: e.details,
          by: actorLabel(e, whoBy.get(String(e.id))),
          reconstructed: !!(e.details && e.details.reconstruido),
        })),
      });
    } catch (err) {
      console.error('[trazabilidad] hoja de vida:', err);
      res.status(500).json({ error: 'No se pudo cargar el historial.' });
    }
  });

  return router;
}

module.exports = { init, makeRouter, EVENT_LABELS };
