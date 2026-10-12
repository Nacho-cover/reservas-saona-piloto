const crypto = require('crypto');
const db = require('./db');
const perms = require('./permissions');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Contraseña provisional legible (sin caracteres que se confundan: 0/O, 1/l/I).
function generateTempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

// Sesiones en memoria: se pierden si el servidor reinicia (plan gratuito de Render
// duerme con inactividad), así que hay que volver a entrar — aceptable para el panel,
// evita montar un almacén de sesiones. Cada sesión es de un usuario concreto.
const sessions = new Map(); // token -> { userId, exp }
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, exp: Date.now() + SESSION_MS });
  return token;
}

function sessionUserId(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.exp) { sessions.delete(token); return null; }
  return s.userId;
}

function isValidSession(token) { return sessionUserId(token) != null; }

function destroySession(token) { sessions.delete(token); }

// Al desactivar un usuario o restablecer su contraseña se cierran sus sesiones abiertas.
function destroyUserSessions(userId) {
  for (const [token, s] of sessions) if (s.userId === userId) sessions.delete(token);
  invalidateUser(userId);
}

// Caché corta de usuarios (rol, locales, activo) para no consultar la base de datos en
// cada petición; se invalida al editar el usuario, así que los cambios son inmediatos.
const userCache = new Map(); // userId -> { user, at }
const USER_CACHE_MS = 30 * 1000;

function invalidateUser(userId) {
  if (userId == null) userCache.clear(); else userCache.delete(userId);
}

async function loadUser(userId) {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.at < USER_CACHE_MS) return cached.user;
  const { rows } = await db.query(
    'SELECT id, email, name, role, active, must_change_password FROM users WHERE id = $1', [userId]);
  if (!rows.length) { userCache.delete(userId); return null; }
  const { rows: rr } = await db.query(
    'SELECT restaurant_id FROM user_restaurants WHERE user_id = $1', [userId]);
  const user = { ...rows[0], restaurantIds: rr.map(r => r.restaurant_id) };
  userCache.set(userId, { user, at: Date.now() });
  return user;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token) {
  const parts = [
    `admin_session=${token}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Max-Age=0');
}

// Usuario de la sesión de esta petición (o null). No responde nada.
async function getSessionUser(req) {
  const token = parseCookies(req).admin_session;
  const userId = sessionUserId(token);
  if (userId == null) return null;
  const user = await loadUser(userId);
  if (!user || !user.active) { destroySession(token); return null; }
  return user;
}

// Middleware base: exige sesión de un usuario activo y deja el usuario en req.user.
// Devuelve 401 JSON en vez de redirigir — la redirección a login.html la hace el JS
// del panel al recibir un 401. Con { allowMustChange: true } deja pasar a quien aún
// tiene que cambiar la contraseña provisional (solo para "quién soy", cambiar
// contraseña y cerrar sesión).
function requireSession({ allowMustChange = false } = {}) {
  return async (req, res, next) => {
    try {
      const user = await getSessionUser(req);
      if (!user) return res.status(401).json({ error: 'No has iniciado sesión.' });
      if (user.must_change_password && !allowMustChange) {
        return res.status(403).json({ error: 'Tienes que cambiar la contraseña provisional antes de seguir.', mustChangePassword: true });
      }
      req.user = user;
      next();
    } catch (err) { next(err); }
  };
}

const requireAdminAuth = requireSession();

// Middleware: sesión + permiso concreto (ver server/permissions.js).
function can(perm) {
  return [requireAdminAuth, (req, res, next) => {
    if (!perms.hasPermission(req.user, perm)) {
      return res.status(403).json({ error: 'Tu usuario no tiene permiso para esto.' });
    }
    next();
  }];
}

// Middleware: el registro :id de `table` debe ser de un local al que el usuario tiene
// acceso (si no existe, se deja seguir y la ruta responde su propio 404).
const OWNED_TABLES = new Set(['reservations', 'shifts', 'shift_date_overrides', 'closures',
  'floor_plans', 'zones', 'tables', 'table_combinations']);
function ownsRow(table, param = 'id') {
  if (!OWNED_TABLES.has(table)) throw new Error(`ownsRow: tabla no permitida ${table}`);
  return async (req, res, next) => {
    try {
      const id = Number(req.params[param]);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Identificador no válido.' });
      const { rows } = await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      if (rows.length && !perms.canAccessRestaurant(req.user, rows[0].restaurant_id)) {
        return res.status(403).json({ error: 'No tienes acceso a este local.' });
      }
      // Estado anterior del registro: lo usa el registro de actividad (server/audit.js).
      if (rows.length) req.ownedRow = rows[0];
      next();
    } catch (err) { next(err); }
  };
}

module.exports = {
  hashPassword, verifyPassword, generateTempPassword,
  createSession, isValidSession, destroySession, destroyUserSessions, invalidateUser,
  parseCookies, setSessionCookie, clearSessionCookie,
  getSessionUser, requireSession, requireAdminAuth, can, ownsRow,
};
