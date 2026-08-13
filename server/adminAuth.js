const crypto = require('crypto');
const db = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Sesiones en memoria: se pierden si el servidor reinicia (plan gratuito de Render
// duerme con inactividad), así que el equipo tendría que volver a entrar — aceptable
// para un panel interno de unas pocas personas, evita montar un almacén de sesiones.
const sessions = new Map(); // token -> expiresAt (ms epoch)
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

function destroySession(token) {
  sessions.delete(token);
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

// Middleware: protege rutas de API del panel de personal. Devuelve 401 JSON en vez
// de redirigir — la redirección a login.html la hace el propio JS del panel al
// recibir un 401 (ver admin.js / config.js).
function requireAdminAuth(req, res, next) {
  const { admin_session: token } = parseCookies(req);
  if (isValidSession(token)) return next();
  return res.status(401).json({ error: 'No has iniciado sesión.' });
}

function getCredential() {
  return db.prepare('SELECT * FROM admin_credentials ORDER BY id LIMIT 1').get();
}

module.exports = {
  hashPassword, verifyPassword, createSession, isValidSession, destroySession,
  parseCookies, setSessionCookie, clearSessionCookie, requireAdminAuth, getCredential,
};
