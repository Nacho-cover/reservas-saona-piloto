// Ficha de cliente común a todo el grupo (como el CRM de Cover): etiquetas (VIP, Lista
// negra…), alergias y notas, más el historial y los no-shows calculados a partir de las
// reservas. El cliente se identifica por su teléfono normalizado (función SQL
// saona_norm_phone, creada en server/db.js; normPhone() de aquí aplica la misma regla).
//
// Decisiones (Nacho, 15/10/2026):
//  - La ficha es común a todos los locales; el historial que ve cada usuario se limita a
//    los locales que tiene asignados (los franquiciados no ven datos de otros).
//  - Un no-show en cualquier local bloquea la reserva web en todo el grupo, igual que la
//    etiqueta Lista negra. El Administrador puede levantar el bloqueo desde la ficha.
//  - Etiquetas y desbloqueo: solo el Administrador (permiso customer_tags). Alergias y
//    notas: cualquiera con permiso reservations.

const express = require('express');
const db = require('./db');
const adminAuth = require('./adminAuth');
const perms = require('./permissions');
const audit = require('./audit');

const TAGS = [
  { id: 'vip', label: 'VIP' },
  { id: 'blacklist', label: 'Lista negra' },
  { id: 'no_paga', label: 'No paga' },
  { id: 'partner', label: 'Partner' },
];
const TAG_IDS = TAGS.map(t => t.id);
const TAG_LABEL = Object.fromEntries(TAGS.map(t => [t.id, t.label]));

// Los 14 alérgenos de declaración obligatoria (Reglamento UE 1169/2011), como en Cover.
const ALLERGENS = ['Altramuces', 'Apio', 'Cacahuetes', 'Crustáceos', 'Frutos de cáscara', 'Gluten', 'Huevos',
  'Lácteos', 'Moluscos', 'Mostaza', 'Pescado', 'Sésamo', 'Soja', 'Sulfitos'];

const VISITED = ['seated', 'eating', 'dessert', 'paid', 'completed'];

function normPhone(p) {
  const d = String(p || '').replace(/[^0-9]/g, '');
  if (!d) return null;
  if (/^0034[0-9]{9}$/.test(d)) return d.slice(4);
  if (/^34[6789][0-9]{8}$/.test(d)) return d.slice(2);
  if (/^00/.test(d)) return d.slice(2);
  return d;
}

function nowMadrid() {
  // 'YYYY-MM-DD HH:MM:SS' en hora de España, comparable con fecha + hora de una reserva.
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' });
  return s.replace('T', ' ').slice(0, 19);
}

async function getProfiles(norms) {
  if (!norms.length) return {};
  const { rows } = await db.query('SELECT * FROM customer_profiles WHERE phone_norm = ANY($1::text[])', [norms]);
  return Object.fromEntries(rows.map(r => [r.phone_norm, r]));
}

// Resumen de varios clientes a la vez (para la lista de reservas del día): etiquetas,
// alergias, visitas y no-shows en todo el grupo, y si la web los tiene bloqueados.
async function summariesByPhone(phones) {
  const norms = [...new Set(phones.map(normPhone).filter(n => n && n.length >= 6))];
  if (!norms.length) return {};
  const profiles = await getProfiles(norms);
  const { rows } = await db.query(`
    SELECT saona_norm_phone(r.phone) AS n,
           COUNT(*) FILTER (WHERE r.status = ANY($2::text[]))::int AS visits,
           COUNT(*) FILTER (WHERE r.status = 'no_show')::int AS no_shows,
           COUNT(*) FILTER (WHERE r.status = 'no_show'
             AND (p.web_unblocked_at IS NULL OR (r.date || ' ' || r.time) > p.web_unblocked_at))::int AS blocking_no_shows
      FROM reservations r
      LEFT JOIN customer_profiles p ON p.phone_norm = saona_norm_phone(r.phone)
     WHERE saona_norm_phone(r.phone) = ANY($1::text[])
     GROUP BY 1`, [norms, VISITED]);
  const counts = Object.fromEntries(rows.map(r => [r.n, r]));
  const out = {};
  for (const n of norms) {
    const p = profiles[n] || {};
    const c = counts[n] || { visits: 0, no_shows: 0, blocking_no_shows: 0 };
    const tags = p.tags || [];
    out[n] = {
      phoneNorm: n,
      tags,
      allergies: p.allergies || [],
      hasNotes: !!(p.notes && p.notes.trim()),
      visits: c.visits,
      noShows: c.no_shows,
      webBlocked: tags.includes('blacklist') || c.blocking_no_shows > 0,
    };
  }
  return out;
}

// ¿Puede este cliente reservar por la web? Comprueba por teléfono y también por email
// (por si da otro teléfono). Devuelve { blocked, reason } — reason es interno, al cliente
// se le da siempre el mismo mensaje.
async function webBlockFor({ phone, email }) {
  const n = normPhone(phone);
  const mail = String(email || '').trim().toLowerCase() || null;
  if (!n && !mail) return { blocked: false };
  const { rows: profRows } = await db.query(`
    SELECT DISTINCT p.* FROM customer_profiles p
     WHERE p.phone_norm = $1
        OR ($2::text IS NOT NULL AND p.phone_norm IN (
             SELECT saona_norm_phone(phone) FROM reservations WHERE lower(email) = $2 AND phone IS NOT NULL))`,
    [n, mail]);
  if (profRows.some(p => (p.tags || []).includes('blacklist'))) return { blocked: true, reason: 'blacklist' };
  const own = profRows.find(p => p.phone_norm === n);
  const unblockedAt = own ? own.web_unblocked_at : null;
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS c FROM reservations
     WHERE status = 'no_show'
       AND (($1::text IS NOT NULL AND saona_norm_phone(phone) = $1) OR ($2::text IS NOT NULL AND lower(email) = $2))
       AND ($3::text IS NULL OR (date || ' ' || time) > $3)`, [n, mail, unblockedAt]);
  if (rows[0].c > 0) return { blocked: true, reason: 'no_show' };
  return { blocked: false };
}

// --- Rutas del panel -------------------------------------------------------------
const router = express.Router();
router.use(adminAuth.can('reservations'));

router.get('/meta', (req, res) => {
  res.json({ tags: TAGS, allergens: ALLERGENS, canEditTags: perms.hasPermission(req.user, 'customer_tags') });
});

async function buildCard(user, norm) {
  const allowed = perms.allowedRestaurantIds(user);
  const profiles = await getProfiles([norm]);
  const p = profiles[norm] || { tags: [], allergies: [], notes: null, web_unblocked_at: null };
  const { rows: statRows } = await db.query(`
    SELECT COUNT(*)::int AS reservations,
           COUNT(*) FILTER (WHERE status = ANY($2::text[]))::int AS visits,
           COUNT(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
           COUNT(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'customer')::int AS cancelled_by_customer,
           COUNT(*) FILTER (WHERE status = 'no_show' AND ($3::text IS NULL OR (date || ' ' || time) > $3))::int AS blocking_no_shows,
           MIN(date) FILTER (WHERE status = ANY($2::text[])) AS first_visit,
           MAX(date) FILTER (WHERE status = ANY($2::text[])) AS last_visit,
           COUNT(DISTINCT restaurant_id) FILTER (WHERE status = ANY($2::text[]))::int AS locales
      FROM reservations WHERE saona_norm_phone(phone) = $1`, [norm, VISITED, p.web_unblocked_at]);
  const s = statRows[0];
  const { rows: history } = await db.query(`
    SELECT r.id, r.date, r.time, r.party_size, r.status, r.source, r.cancelled_by, r.customer_name, r.email,
           r.restaurant_id, rest.name AS restaurant_name
      FROM reservations r JOIN restaurants rest ON rest.id = r.restaurant_id
     WHERE saona_norm_phone(r.phone) = $1 ${allowed === null ? '' : 'AND r.restaurant_id = ANY($2::int[])'}
     ORDER BY r.date DESC, r.time DESC LIMIT 40`, allowed === null ? [norm] : [norm, allowed]);
  const latest = history[0] || null;
  const blacklisted = (p.tags || []).includes('blacklist');
  return {
    phoneNorm: norm,
    name: latest ? latest.customer_name : null,
    email: (history.find(h => h.email) || {}).email || null,
    tags: p.tags || [],
    allergies: p.allergies || [],
    notes: p.notes || '',
    updatedAt: p.updated_at || null,
    stats: {
      reservations: s.reservations, visits: s.visits, noShows: s.no_shows,
      cancelledByCustomer: s.cancelled_by_customer, firstVisit: s.first_visit, lastVisit: s.last_visit,
      locales: s.locales,
    },
    web: {
      blocked: blacklisted || s.blocking_no_shows > 0,
      reason: blacklisted ? 'blacklist' : (s.blocking_no_shows > 0 ? 'no_show' : null),
      unblockedAt: p.web_unblocked_at || null,
    },
    history: history.map(h => ({
      id: h.id, date: h.date, time: h.time, partySize: h.party_size, status: h.status, source: h.source,
      cancelledBy: h.cancelled_by, restaurantId: h.restaurant_id, restaurant: h.restaurant_name,
    })),
    historyLimitedToYourLocales: allowed !== null,
    canEditTags: perms.hasPermission(user, 'customer_tags'),
  };
}

function normFromReq(req, res) {
  const n = normPhone(req.query.phone || (req.body && req.body.phone));
  if (!n || n.length < 6) { res.status(400).json({ error: 'Indica un teléfono válido.' }); return null; }
  return n;
}

router.get('/profile', async (req, res) => {
  const n = normFromReq(req, res);
  if (!n) return;
  res.json(await buildCard(req.user, n));
});

router.put('/profile', async (req, res) => {
  const n = normFromReq(req, res);
  if (!n) return;
  const { tags, allergies, notes, restaurantId } = req.body || {};
  if (tags !== undefined && !perms.hasPermission(req.user, 'customer_tags')) {
    return res.status(403).json({ error: 'Solo el Administrador puede cambiar las etiquetas del cliente.' });
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some(t => !TAG_IDS.includes(t)))) {
    return res.status(400).json({ error: 'Etiqueta no válida.' });
  }
  if (allergies !== undefined && (!Array.isArray(allergies) || allergies.some(a => !ALLERGENS.includes(a)))) {
    return res.status(400).json({ error: 'Alérgeno no válido.' });
  }
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 2000)) {
    return res.status(400).json({ error: 'Las notas no pueden pasar de 2000 caracteres.' });
  }
  const before = (await getProfiles([n]))[n] || { tags: [], allergies: [], notes: '' };
  const next = {
    tags: tags !== undefined ? [...new Set(tags)] : before.tags,
    allergies: allergies !== undefined ? [...new Set(allergies)] : before.allergies,
    notes: notes !== undefined ? notes.trim() : before.notes,
  };
  await db.query(`
    INSERT INTO customer_profiles (phone_norm, tags, allergies, notes, updated_at, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (phone_norm) DO UPDATE SET tags = $2, allergies = $3, notes = $4, updated_at = $5, updated_by = $6`,
  [n, next.tags, next.allergies, next.notes || null, nowMadrid(), req.user.id]);

  // Registro de actividad legible: qué cambió.
  const diff = (a, b, label) => {
    const added = b.filter(x => !a.includes(x)).map(label);
    const removed = a.filter(x => !b.includes(x)).map(label);
    return [added.length ? '+' + added.join(', +') : '', removed.length ? '−' + removed.join(', −') : ''].filter(Boolean).join(' ');
  };
  const parts = [];
  const tagDiff = diff(before.tags || [], next.tags, t => TAG_LABEL[t] || t);
  if (tagDiff) parts.push('etiquetas ' + tagDiff);
  const allDiff = diff(before.allergies || [], next.allergies, a => a);
  if (allDiff) parts.push('alergias ' + allDiff);
  if ((before.notes || '') !== (next.notes || '')) parts.push('notas cambiadas');
  if (parts.length) {
    audit.record({
      user: req.user, restaurantId: Number(restaurantId) || null, action: 'cliente.ficha',
      summary: `Ficha del cliente …${n.slice(-4)}: ${parts.join(' · ')}`,
      details: { phoneNorm: n, before: { tags: before.tags, allergies: before.allergies }, after: { tags: next.tags, allergies: next.allergies } },
    });
  }
  res.json(await buildCard(req.user, n));
});

router.post('/profile/unblock', adminAuth.can('customer_tags'), async (req, res) => {
  const n = normFromReq(req, res);
  if (!n) return;
  const at = nowMadrid();
  await db.query(`
    INSERT INTO customer_profiles (phone_norm, web_unblocked_at, updated_at, updated_by) VALUES ($1, $2, $2, $3)
    ON CONFLICT (phone_norm) DO UPDATE SET web_unblocked_at = $2, updated_at = $2, updated_by = $3`, [n, at, req.user.id]);
  audit.record({
    user: req.user, restaurantId: Number(req.body.restaurantId) || null, action: 'cliente.desbloquear',
    summary: `Reserva web desbloqueada para el cliente …${n.slice(-4)} (se perdonan sus no-shows anteriores)`,
    details: { phoneNorm: n, at },
  });
  res.json(await buildCard(req.user, n));
});

module.exports = { router, normPhone, summariesByPhone, webBlockFor, TAGS, ALLERGENS };
