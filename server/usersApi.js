// Gestión de usuarios del panel (solo Administrador).
//
//   GET    /api/admin/users                     → { users, roles, restaurants }
//   POST   /api/admin/users                     → crea usuario; devuelve la contraseña provisional (una sola vez)
//   PATCH  /api/admin/users/:id                 → nombre, rol, locales, activo
//   POST   /api/admin/users/:id/reset-password  → nueva contraseña provisional (una sola vez)
//   POST   /api/admin/users/:id/invite          → manda por email un enlace para elegir contraseña
//   POST   /api/admin/users/bulk                → alta de varios usuarios a la vez (importación de Excel)
//
// La contraseña provisional obliga a cambiarla en el primer acceso. Nunca se guarda en
// claro ni se puede volver a consultar.

const express = require('express');
const db = require('./db');
const adminAuth = require('./adminAuth');
const perms = require('./permissions');
const accountEmails = require('./accountEmails');

const router = express.Router();
router.use(adminAuth.can('users'));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function listUsers() {
  const { rows: users } = await db.query(`
    SELECT id, email, name, role, active, must_change_password, created_at, last_login_at
      FROM users ORDER BY active DESC, lower(coalesce(name, email))`);
  const { rows: links } = await db.query('SELECT user_id, restaurant_id FROM user_restaurants');
  const byUser = {};
  for (const l of links) (byUser[l.user_id] = byUser[l.user_id] || []).push(l.restaurant_id);
  return users.map(u => ({
    id: u.id, email: u.email, name: u.name, role: u.role, active: u.active,
    mustChangePassword: u.must_change_password, createdAt: u.created_at, lastLoginAt: u.last_login_at,
    restaurantIds: byUser[u.id] || [],
  }));
}

// Valida y limpia la lista de locales (solo ids que existen).
async function cleanRestaurantIds(ids) {
  if (!Array.isArray(ids)) return [];
  const nums = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!nums.length) return [];
  const { rows } = await db.query('SELECT id FROM restaurants WHERE id = ANY($1::int[])', [nums]);
  return rows.map(r => r.id);
}

async function setRestaurants(client, userId, ids) {
  await client.query('DELETE FROM user_restaurants WHERE user_id = $1', [userId]);
  for (const rid of ids) {
    await client.query('INSERT INTO user_restaurants (user_id, restaurant_id) VALUES ($1, $2)', [userId, rid]);
  }
}

async function activeAdminCount(excludeId) {
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND active AND id <> $1", [excludeId || 0]);
  return rows[0].c;
}

router.get('/', async (req, res) => {
  const { rows: restaurants } = await db.query('SELECT id, name FROM restaurants ORDER BY name');
  res.json({
    users: await listUsers(),
    roles: Object.entries(perms.ROLES).map(([id, r]) => ({
      id, label: r.label, description: r.description, allRestaurants: !!r.allRestaurants, permissions: r.permissions,
    })),
    permissions: perms.PERMISSIONS,
    restaurants,
    currentUserId: req.user.id,
  });
});

router.post('/', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 80) || null;
  const role = req.body.role;
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Escribe un correo válido.' });
  if (!perms.ROLES[role]) return res.status(400).json({ error: 'Elige un rol.' });
  const restaurantIds = await cleanRestaurantIds(req.body.restaurantIds);
  if (!perms.ROLES[role].allRestaurants && !restaurantIds.length) {
    return res.status(400).json({ error: 'Asigna al menos un local.' });
  }
  const { rows: existing } = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (existing.length) return res.status(409).json({ error: 'Ya existe un usuario con ese correo.' });

  const tempPassword = adminAuth.generateTempPassword();
  const id = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (email, name, role, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [email, name, role, adminAuth.hashPassword(tempPassword)]);
    await setRestaurants(client, rows[0].id, perms.ROLES[role].allRestaurants ? [] : restaurantIds);
    return rows[0].id;
  });
  const user = (await listUsers()).find(u => u.id === id);
  let emailSent = null;
  if (req.body.sendInvite) emailSent = await invite(req, user);
  res.status(201).json({ user, tempPassword, emailSent });
});

// Manda la invitación por email. Devuelve true/false según si Resend la aceptó.
async function invite(req, user) {
  const result = await accountEmails.sendInviteEmail(req, user, req.user.name || req.user.email);
  return !!(result && result.ok);
}

router.post('/:id/invite', async (req, res) => {
  const user = (await listUsers()).find(u => u.id === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
  if (!user.active) return res.status(400).json({ error: 'El usuario está desactivado.' });
  const ok = await invite(req, user);
  if (!ok) return res.status(502).json({ error: 'No se pudo enviar el email. Comprueba la configuración de envío (Resend) o pásale una contraseña provisional.' });
  res.json({ ok: true });
});

// Alta masiva. Cuerpo: { users: [{ email, name, role, restaurantIds }], sendInvites }.
// Se valida todo antes de crear nada; los correos que ya existen se saltan (no es un
// error). Devuelve la contraseña provisional de cada usuario creado (una sola vez).
router.post('/bulk', async (req, res) => {
  const input = Array.isArray(req.body.users) ? req.body.users : [];
  if (!input.length) return res.status(400).json({ error: 'No hay usuarios que importar.' });
  if (input.length > 500) return res.status(400).json({ error: 'Como máximo 500 usuarios por importación.' });

  const { rows: allRest } = await db.query('SELECT id FROM restaurants');
  const validRest = new Set(allRest.map(r => r.id));
  const { rows: existingRows } = await db.query('SELECT email FROM users');
  const existing = new Set(existingRows.map(r => r.email));

  const errors = [];
  const skipped = [];
  const toCreate = [];
  const seen = new Set();
  input.forEach((u, i) => {
    const row = i + 1;
    const email = String(u.email || '').trim().toLowerCase();
    const role = String(u.role || '').trim();
    const ids = [...new Set((Array.isArray(u.restaurantIds) ? u.restaurantIds : []).map(Number))];
    if (!EMAIL_RE.test(email)) return errors.push({ row, email, error: 'Correo no válido' });
    if (seen.has(email)) return errors.push({ row, email, error: 'Correo repetido en el fichero' });
    seen.add(email);
    if (existing.has(email)) return skipped.push({ row, email, reason: 'Ya existe' });
    if (!perms.ROLES[role]) return errors.push({ row, email, error: 'Rol no válido' });
    if (ids.some(id => !validRest.has(id))) return errors.push({ row, email, error: 'Algún local no existe' });
    if (!perms.ROLES[role].allRestaurants && !ids.length) return errors.push({ row, email, error: 'Sin locales asignados' });
    toCreate.push({ email, name: String(u.name || '').trim().slice(0, 80) || null, role,
      restaurantIds: perms.ROLES[role].allRestaurants ? [] : ids });
  });
  if (errors.length) return res.status(400).json({ error: `Hay ${errors.length} fila(s) con errores; no se ha creado ningún usuario.`, errors });

  const created = await db.withTransaction(async (client) => {
    const out = [];
    for (const u of toCreate) {
      const tempPassword = adminAuth.generateTempPassword();
      const { rows } = await client.query(
        `INSERT INTO users (email, name, role, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [u.email, u.name, u.role, adminAuth.hashPassword(tempPassword)]);
      await setRestaurants(client, rows[0].id, u.restaurantIds);
      out.push({ id: rows[0].id, email: u.email, name: u.name, role: u.role, restaurantIds: u.restaurantIds, tempPassword });
    }
    return out;
  });

  // Las invitaciones se mandan después de crear (si alguna falla, el usuario ya existe
  // y se puede reenviar desde la lista o usar su contraseña provisional).
  if (req.body.sendInvites) {
    for (const u of created) u.emailSent = await invite(req, u);
  }
  res.status(201).json({ created, skipped });
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Usuario no encontrado.' });

  const role = req.body.role != null ? req.body.role : existing.role;
  if (!perms.ROLES[role]) return res.status(400).json({ error: 'Rol no válido.' });
  const active = req.body.active != null ? !!req.body.active : existing.active;
  const name = req.body.name !== undefined ? (String(req.body.name || '').trim().slice(0, 80) || null) : existing.name;

  // Salvaguardas: nadie se quita a sí mismo el acceso de administrador, y siempre
  // tiene que quedar al menos un administrador activo.
  if (id === req.user.id && (!active || role !== 'admin')) {
    return res.status(400).json({ error: 'No puedes desactivarte ni quitarte el rol de Administrador a ti mismo.' });
  }
  if (existing.role === 'admin' && existing.active && (role !== 'admin' || !active) && (await activeAdminCount(id)) === 0) {
    return res.status(400).json({ error: 'Tiene que quedar al menos un Administrador activo.' });
  }

  let restaurantIds = null;
  if (req.body.restaurantIds !== undefined) restaurantIds = await cleanRestaurantIds(req.body.restaurantIds);
  if (!perms.ROLES[role].allRestaurants) {
    const finalIds = restaurantIds !== null ? restaurantIds
      : (await db.query('SELECT restaurant_id FROM user_restaurants WHERE user_id = $1', [id])).rows.map(r => r.restaurant_id);
    if (!finalIds.length) return res.status(400).json({ error: 'Asigna al menos un local.' });
  }

  await db.withTransaction(async (client) => {
    await client.query('UPDATE users SET name = $1, role = $2, active = $3 WHERE id = $4', [name, role, active, id]);
    if (perms.ROLES[role].allRestaurants) await setRestaurants(client, id, []);
    else if (restaurantIds !== null) await setRestaurants(client, id, restaurantIds);
  });
  if (!active) adminAuth.destroyUserSessions(id); else adminAuth.invalidateUser(id);
  res.json({ user: (await listUsers()).find(u => u.id === id) });
});

router.post('/:id/reset-password', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Para tu propio usuario usa «Cambiar contraseña».' });
  }
  const tempPassword = adminAuth.generateTempPassword();
  const { rowCount } = await db.query(
    'UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2',
    [adminAuth.hashPassword(tempPassword), id]);
  if (!rowCount) return res.status(404).json({ error: 'Usuario no encontrado.' });
  adminAuth.destroyUserSessions(id);
  res.json({ tempPassword });
});

router.use((err, req, res, _next) => {
  console.error('[usuarios]', err);
  res.status(500).json({ error: 'Error interno.' });
});

module.exports = router;
