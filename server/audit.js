// Registro de actividad del panel: quién cambió qué, en qué local y cuándo.
//
// Se apunta solo, sin tocar cada ruta: un middleware espera a que termine cada
// petición que cambia algo (POST/PUT/PATCH/DELETE) hecha por un usuario con sesión y,
// si salió bien (código < 400), guarda una fila en audit_log con una frase legible
// ("Reserva #12 García · 4 pax · 21:00 → Sentada") y el detalle de lo enviado. Las
// contraseñas y claves nunca se guardan. Las reservas que hacen los clientes por la
// web no se apuntan (no hay usuario del panel detrás).
//
// La pantalla admin/actividad.html lo consulta vía GET /api/admin/activity.

const express = require('express');
const db = require('./db');
const adminAuth = require('./adminAuth');
const perms = require('./permissions');

const STATUS = {
  confirmed: 'Confirmada', seated: 'Sentada', eating: 'Comiendo', dessert: 'Postre', paid: 'Pagada',
  completed: 'Completada', cancelled: 'Cancelada', no_show: 'No show',
};
const SECRET_KEYS = /pass|token|secret|key$/i;

function resv(r) {
  if (!r) return 'Reserva';
  return `Reserva #${r.id} ${r.customer_name || ''} · ${r.party_size} pax · ${r.date} ${r.time}`.replace(/\s+/g, ' ');
}

// Frase legible para cada tipo de cambio. `b` = cuerpo enviado, `o` = registro antes
// del cambio (si la ruta lleva :id), `out` = lo que respondió el servidor.
const ACTIONS = {
  'POST /api/reservations': ['reserva.crear', (b, o, out) =>
    `Reserva creada (${{ phone: 'teléfono', admin: 'panel', walkin: 'walk-in' }[b.source] || b.source}) ${b.customerName || ''} · ${b.partySize} pax · ${b.date} ${b.time}${out && out.tables ? ' · mesa ' + out.tables.join('+') : ''}`],
  'PATCH /api/reservations/:id': ['reserva.estado', (b, o) =>
    b.status ? `${resv(o)} → ${STATUS[b.status] || b.status}${b.status === 'cancelled' ? (b.cancelledBy === 'customer' ? ' (por el cliente)' : ' (por el restaurante)') : ''}`
      : `${resv(o)}: notas cambiadas`],
  'DELETE /api/reservations/:id': ['reserva.cancelar', (b, o) => `${resv(o)} → Cancelada`],
  'PATCH /api/reservations/:id/table': ['reserva.mover', (b, o, out) =>
    `${resv(o)} movida a mesa ${out && out.tables ? out.tables.join('+') : (b.tableIds || []).join('+')}${b.force ? ' (forzada)' : ''}`],
  'POST /api/reservations/swap': ['reserva.intercambiar', (b) => `Intercambio de mesas entre reservas #${b.reservationIdA} y #${b.reservationIdB}`],
  'POST /api/shifts': ['horario.semanal', (b) =>
    `Horario semanal: ${b.name} ${['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][b.dayOfWeek] || ''} ${b.startTime}-${b.endTime}`],
  'DELETE /api/shifts/:id': ['horario.semanal.quitar', (b, o) =>
    `Turno semanal quitado: ${o ? o.name + ' ' + ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][o.day_of_week] : ''}`],
  'POST /api/shift-date-overrides': ['horario.excepcion', (b) =>
    `Excepción de horario: ${b.shiftName} ${b.startTime}-${b.endTime} (${(b.dates || []).length === 1 ? b.dates[0] : (b.dates || []).length + ' días'})`],
  'DELETE /api/shift-date-overrides/:id': ['horario.excepcion.quitar', (b, o) =>
    `Excepción de horario quitada: ${o ? `${o.shift_name} ${o.date}` : ''}`],
  'POST /api/closures': ['cierre', (b) => `Cierre: ${b.shift ? 'turno ' + b.shift : 'todo el día'} ${b.date}`],
  'DELETE /api/closures/:id': ['cierre.quitar', (b, o) => `Reabierto: ${o ? (o.shift ? 'turno ' + o.shift : 'todo el día') + ' ' + o.date : ''}`],
  'POST /api/floor-plans': ['plano.crear', (b) => `Plano creado: ${b.name}${b.cloneFromId ? ' (copia)' : ''}`],
  'PATCH /api/floor-plans/:id': ['plano.editar', (b, o) => `Plano editado: ${o ? o.name : ''}${b.name && o && b.name !== o.name ? ' → ' + b.name : ''}`],
  'PUT /api/floor-plan-schedule': ['plano.agenda', (b) => `Plano asignado al ${b.date}`],
  'DELETE /api/floor-plan-schedule': ['plano.agenda.quitar', (b, o, out, q) => `Quitada la asignación de plano del ${b.date || q.date || ''}`],
  'POST /api/zones': ['zona.crear', (b) => `Zona creada: ${b.name}`],
  'DELETE /api/zones/:id': ['zona.borrar', (b, o) => `Zona eliminada: ${o ? o.name : ''}`],
  'POST /api/tables': ['mesa.crear', (b) => `Mesa creada: ${b.name} (${b.capacityMin || 1}-${b.capacityMax})`],
  'PATCH /api/tables/:id': ['mesa.editar', (b, o) => {
    const keys = Object.keys(b);
    if (keys.every(k => ['posX', 'posY', 'restaurantId'].includes(k))) return `Mesa ${o ? o.name : ''} movida en el plano`;
    return `Mesa editada: ${o ? o.name : ''}${b.name && o && b.name !== o.name ? ' → ' + b.name : ''}${b.capacityMax ? ` (${b.capacityMin || o.capacity_min}-${b.capacityMax})` : ''}`;
  }],
  'DELETE /api/tables/:id': ['mesa.borrar', (b, o) => `Mesa eliminada: ${o ? o.name : ''}`],
  'POST /api/combinations': ['combinacion.crear', (b) => `Combinación creada: ${b.name}`],
  'DELETE /api/combinations/:id': ['combinacion.borrar', (b, o) => `Combinación eliminada: ${o ? o.name : ''}`],
  'POST /api/admin/users': ['usuario.crear', (b) => `Usuario creado: ${b.email} (${perms.ROLES[b.role] ? perms.ROLES[b.role].label : b.role})`],
  'POST /api/admin/users/bulk': ['usuario.importar', (b, o, out) => `Importación de usuarios: ${out && out.created ? out.created.length : 0} creados`],
  'PATCH /api/admin/users/:id': ['usuario.editar', (b, o, out) => {
    const u = out && out.user;
    const parts = [];
    if (b.role) parts.push(`rol ${perms.ROLES[b.role] ? perms.ROLES[b.role].label : b.role}`);
    if (b.restaurantIds) parts.push(`${b.restaurantIds.length} locales`);
    if (b.active === false) parts.push('desactivado');
    if (b.active === true && Object.keys(b).length === 1) parts.push('reactivado');
    return `Usuario ${u ? u.email : ''}: ${parts.join(', ') || 'editado'}`;
  }],
  'POST /api/admin/users/:id/reset-password': ['usuario.contraseña', (b, o, out, q, p) => `Contraseña provisional nueva para el usuario #${p.id}`],
  'POST /api/admin/users/:id/invite': ['usuario.invitar', (b, o, out, q, p) => `Invitación enviada al usuario #${p.id}`],
  'POST /api/admin/api-keys': ['api.clave.crear', (b) => `Clave de API creada: ${b.label}`],
  'DELETE /api/admin/api-keys/:id': ['api.clave.revocar', (b, o, out, q, p) => `Clave de API revocada #${p.id}`],
  'POST /api/admin/change-password': ['sesion.contraseña', () => 'Cambió su contraseña'],
};

function sanitize(obj, depth = 0) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.slice(0, 50).map(v => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(k)) continue;
    out[k] = depth > 2 ? '…' : sanitize(v, depth + 1);
  }
  return out;
}

async function record({ user, restaurantId, action, summary, details }) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, user_email, restaurant_id, action, summary, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user ? user.id : null, user ? user.email : null, restaurantId || null, action,
        summary ? String(summary).slice(0, 500) : null, details ? JSON.stringify(details).slice(0, 8000) : null]);
  } catch (err) {
    // El registro nunca debe romper la operación que se está haciendo.
    console.error('[actividad] no se pudo guardar:', err.message);
  }
}

// Middleware global (se monta antes de las rutas). Captura la respuesta JSON para
// poder describir el resultado (p. ej. la mesa asignada a una reserva nueva).
function middleware(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const originalJson = res.json.bind(res);
  res.json = (body) => { res.locals.auditOut = body; return originalJson(body); };
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.user || !req.route) return;
    const key = `${req.method} ${req.baseUrl || ''}${req.route.path}`;
    const def = ACTIONS[key];
    if (!def) return;
    const [action, describe] = def;
    const body = req.body || {};
    const before = req.ownedRow || null;
    const out = res.locals.auditOut;
    let summary;
    try { summary = describe(body, before, out, req.query || {}, req.params || {}); } catch { summary = key; }
    const restaurantId = (req.restaurant && req.restaurant.id) || (before && before.restaurant_id)
      || (out && !Array.isArray(out) && out.restaurant_id) || null;
    record({
      user: req.user, restaurantId, action, summary,
      details: { route: key, params: req.params, body: sanitize(body), before: before ? sanitize(before) : undefined },
    });
  });
  next();
}

// --- Consulta (pantalla Actividad) ----------------------------------------------
// Administrador: todo. Operaciones y franquiciado (permiso reports): lo de sus locales.
const router = express.Router();
router.use(adminAuth.can('reports'));

router.get('/', async (req, res) => {
  const allowed = perms.allowedRestaurantIds(req.user);
  const isAdmin = perms.hasPermission(req.user, 'users');
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

  if (req.query.restaurantId && req.query.restaurantId !== 'all') {
    const id = Number(req.query.restaurantId);
    if (!perms.canAccessRestaurant(req.user, id)) return res.status(403).json({ error: 'No tienes acceso a este local.' });
    add('a.restaurant_id = ?', id);
  } else if (allowed !== null) {
    add('a.restaurant_id = ANY(?::int[])', allowed);
  }
  // Los cambios sin local (usuarios, claves de API) solo los ve el Administrador.
  if (!isAdmin) where.push('a.restaurant_id IS NOT NULL');
  if (req.query.userId) add('a.user_id = ?', Number(req.query.userId));
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) add("a.at >= (?::date AT TIME ZONE 'Europe/Madrid')", req.query.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) add("a.at < ((?::date + 1) AT TIME ZONE 'Europe/Madrid')", req.query.to);
  if (req.query.area) add("split_part(a.action, '.', 1) = ?", String(req.query.area));
  if (req.query.q) add('a.summary ILIKE ?', `%${String(req.query.q).slice(0, 80)}%`);
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);

  const { rows } = await db.query(`
    SELECT a.id, to_char(a.at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD HH24:MI:SS') AS at,
           a.user_id, COALESCE(u.name, a.user_email) AS user_name, a.user_email,
           a.restaurant_id, r.name AS restaurant_name, a.action, a.summary, a.details
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN restaurants r ON r.id = a.restaurant_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.at DESC, a.id DESC
     LIMIT ${limit}`, params);

  // Usuarios para el filtro: los que aparecen en el registro visible para este usuario.
  const { rows: users } = await db.query(`
    SELECT DISTINCT a.user_id AS id, COALESCE(u.name, a.user_email) AS name
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.user_id IS NOT NULL ${allowed !== null ? 'AND a.restaurant_id = ANY($1::int[])' : ''}
     ORDER BY 2`, allowed !== null ? [allowed] : []);

  res.json({ entries: rows, users, limit });
});

module.exports = { middleware, record, router, ACTIONS };
