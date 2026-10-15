// Lista de espera, gestión de la reserva por el cliente y recordatorio del día antes.
//
// Decisiones de Nacho (15/10/2026):
//  - El cliente se apunta desde la web (horas sin mesa) y el personal desde el panel.
//  - Al cancelarse una reserva se avisa AUTOMÁTICAMENTE al primero de la lista que encaje
//    (comensales y la hora exacta que pidió). Tiene OFFER_MINUTES para confirmar desde el
//    enlace; si no, se ofrece al siguiente. El encargado puede avisar a mano a otra hora.
//  - Avisos por WhatsApp (con email de respaldo) — ver server/notify.js.
//  - Recordatorio el día antes con enlace para confirmar asistencia o cancelar.
//
// Solo hay una oferta activa a la vez por local y día: así la misma mesa no se ofrece a
// dos personas. Al aceptar o caducar una oferta se vuelve a mirar la lista.

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const adminAuth = require('./adminAuth');
const perms = require('./permissions');
const audit = require('./audit');
const availability = require('./availability');
const notify = require('./notify');
const customers = require('./customers');

const OFFER_MINUTES = Number(process.env.WAITLIST_OFFER_MINUTES) || 15;
const FLEX_MINUTES = 0; // solo la hora pedida (en la web solo se pueden pedir horas completas)

function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  if (!req) return 'https://reservas-saona-piloto.onrender.com';
  const proto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}
function madridNow() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).replace('T', ' ');
  return { stamp: s.slice(0, 19), date: s.slice(0, 10), minutes: Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16)) };
}
function addMinutesStamp(stamp, mins) {
  // stamp en hora de España 'YYYY-MM-DD HH:MM:SS' → +mins (aritmética local, suficiente para 15 min)
  const d = new Date(stamp.replace(' ', 'T') + 'Z');
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
const newKey = () => crypto.randomBytes(16).toString('hex');

async function restaurantById(id) {
  const { rows } = await db.query('SELECT * FROM restaurants WHERE id = $1', [id]);
  return rows[0];
}

// Hora que se puede ofrecer a esta entrada ahora mismo (o null): la franja pedida, si sigue
// existiendo ese día, tiene mesa libre y cupo.
async function findOfferTime(restaurant, entry) {
  const now = madridNow();
  if (entry.date < now.date) return null;
  const wanted = availability.toMinutes(entry.time);
  const slots = (await availability.candidateSlots(restaurant, entry.date))
    .filter(s => Math.abs(s.minutes - wanted) <= FLEX_MINUTES)
    .filter(s => entry.date > now.date || s.minutes > now.minutes + 10)
    .sort((a, b) => Math.abs(a.minutes - wanted) - Math.abs(b.minutes - wanted));
  for (const s of slots) {
    const tables = await availability.findAvailableTable(restaurant.id, entry.date, s.minutes,
      restaurant.default_duration_minutes, entry.party_size, restaurant.turnover_buffer_minutes, null, null);
    if (!tables) continue;
    if (!(await availability.hasCapacityRoom(restaurant.id, entry.date, s.minutes, entry.party_size, null))) continue;
    return s.time;
  }
  return null;
}

async function makeOffer(restaurant, entry, time, req) {
  const now = madridNow().stamp;
  const { rows } = await db.query(`
    UPDATE waitlist SET status = 'offered', offer_time = $2, offered_at = $3, offer_expires_at = $4
     WHERE id = $1 AND status IN ('waiting', 'expired') RETURNING *`,
  [entry.id, time, now, addMinutesStamp(now, OFFER_MINUTES)]);
  if (!rows[0]) return null;
  const sent = await notify.sendWaitlistOffer({ restaurant, entry: rows[0], baseUrl: baseUrl(req), minutes: OFFER_MINUTES });
  return { entry: rows[0], sent };
}

// Revisa la lista de un local y día: caduca ofertas vencidas y, si no hay ninguna activa,
// ofrece mesa al primero que encaje. Se llama al cancelar una reserva, al aceptar o
// caducar una oferta, desde el proceso programado y al abrir la lista en el panel.
const running = new Set();
async function processDay(restaurantId, date, req) {
  const k = `${restaurantId}|${date}`;
  if (running.has(k)) return null;
  running.add(k);
  try {
    const now = madridNow().stamp;
    await db.query(`UPDATE waitlist SET status = 'expired'
      WHERE restaurant_id = $1 AND date = $2 AND status = 'offered' AND offer_expires_at < $3`, [restaurantId, date, now]);
    // Ofertas aceptadas cuya reserva desapareció (no terminó la tarjeta): se dan por caducadas.
    await db.query(`UPDATE waitlist w SET status = 'expired'
      WHERE w.restaurant_id = $1 AND w.date = $2 AND w.status = 'accepted'
        AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.id = w.reservation_id)`, [restaurantId, date]);
    const { rows: active } = await db.query(`SELECT 1 FROM waitlist WHERE restaurant_id = $1 AND date = $2 AND status = 'offered'`, [restaurantId, date]);
    if (active.length) return null;
    const restaurant = await restaurantById(restaurantId);
    if (!restaurant) return null;
    const { rows: waiting } = await db.query(`SELECT * FROM waitlist WHERE restaurant_id = $1 AND date = $2 AND status = 'waiting'
      ORDER BY created_at, id`, [restaurantId, date]);
    for (const entry of waiting) {
      const time = await findOfferTime(restaurant, entry);
      if (time) return makeOffer(restaurant, entry, time, req);
    }
    return null;
  } finally {
    running.delete(k);
  }
}
// Para llamar sin esperar (p. ej. justo después de cancelar una reserva).
function onReservationFreed(restaurantId, date, req) {
  processDay(restaurantId, date, req).catch(err => console.error('[lista de espera]', err.message));
}

// Una reserva web hecha desde una oferta: se marca la entrada como aceptada.
async function markAccepted({ waitlistId, waitlistKey, reservationId, restaurantId, date }) {
  if (!waitlistId || !waitlistKey) return;
  await db.query(`UPDATE waitlist SET status = 'accepted', reservation_id = $3
    WHERE id = $1 AND access_key = $2 AND status IN ('offered', 'expired', 'waiting')`, [Number(waitlistId), String(waitlistKey), reservationId]);
  onReservationFreed(restaurantId, date, null); // por si queda más sitio para el siguiente
}

async function ensureManageKey(reservation) {
  if (reservation.manage_key) return reservation.manage_key;
  const key = newKey();
  await db.query('UPDATE reservations SET manage_key = COALESCE(manage_key, $2) WHERE id = $1', [reservation.id, key]);
  const { rows } = await db.query('SELECT manage_key FROM reservations WHERE id = $1', [reservation.id]);
  return rows[0].manage_key;
}

function parseToken(token) {
  const m = /^(\d+)-([a-f0-9]{32})$/.exec(String(token || ''));
  return m ? { id: Number(m[1]), key: m[2] } : null;
}

function validEntryInput(b) {
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) errors.push('Fecha no válida.');
  if (!/^\d{2}:\d{2}$/.test(b.time || '')) errors.push('Hora no válida.');
  const n = Number(b.partySize);
  if (!Number.isInteger(n) || n < 1 || n > 40) errors.push('Número de comensales no válido.');
  if (!String(b.customerName || '').trim()) errors.push('Indica el nombre.');
  return errors;
}

function makeRouter() {
  const router = express.Router();

  // --- Enlaces cortos de WhatsApp / email -------------------------------------------
  router.get('/r/:token', async (req, res) => {
    const t = parseToken(req.params.token);
    const { rows } = t ? await db.query('SELECT restaurant_id FROM reservations WHERE id = $1 AND manage_key = $2', [t.id, t.key]) : { rows: [] };
    if (!rows[0]) return res.redirect(303, '/?enlace=caducado');
    res.redirect(303, `/?restaurantId=${rows[0].restaurant_id}&gestion=${t.id}&k=${t.key}`);
  });
  router.get('/l/:token', async (req, res) => {
    const t = parseToken(req.params.token);
    const { rows } = t ? await db.query('SELECT restaurant_id FROM waitlist WHERE id = $1 AND access_key = $2', [t.id, t.key]) : { rows: [] };
    if (!rows[0]) return res.redirect(303, '/?enlace=caducado');
    res.redirect(303, `/?restaurantId=${rows[0].restaurant_id}&lista=${t.id}&k=${t.key}`);
  });

  // --- Web de clientes: apuntarse a la lista ----------------------------------------
  router.post('/api/waitlist', async (req, res) => {
    const b = req.body || {};
    const restaurant = await restaurantById(Number(b.restaurantId));
    if (!restaurant) return res.status(404).json({ error: 'Restaurante no encontrado' });
    const errors = validEntryInput(b);
    if (!String(b.phone || '').replace(/[^0-9]/g, '')) errors.push('Indica un teléfono: te avisaremos por WhatsApp.');
    if (!b.consentAccepted) errors.push('Debes aceptar el tratamiento de datos.');
    if (errors.length) return res.status(400).json({ error: errors[0] });
    if (b.date < madridNow().date) return res.status(400).json({ error: 'La fecha ya ha pasado.' });
    const block = await customers.webBlockFor({ phone: b.phone, email: b.email });
    if (block.blocked) return res.status(403).json({ error: `No podemos apuntarte online. Llama al restaurante${restaurant.phone ? ' (' + restaurant.phone + ')' : ''}.` });
    const { rows: dup } = await db.query(`SELECT id FROM waitlist WHERE restaurant_id = $1 AND date = $2 AND status IN ('waiting','offered')
      AND saona_norm_phone(phone) = saona_norm_phone($3)`, [restaurant.id, b.date, b.phone]);
    if (dup.length) return res.status(409).json({ error: 'Ya estás en la lista de espera de ese día. Te avisaremos si se libera una mesa.' });
    const { rows } = await db.query(`INSERT INTO waitlist (restaurant_id, date, time, party_size, customer_name, phone, email, notes, source, access_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'web',$9) RETURNING id, date, time, party_size`,
    [restaurant.id, b.date, b.time, Number(b.partySize), String(b.customerName).trim(), String(b.phone).trim(), (b.email || '').trim() || null, (b.notes || '').trim() || null, newKey()]);
    // Puede que ya haya sitio (se liberó algo mientras elegía): se mira en el momento.
    onReservationFreed(restaurant.id, b.date, req);
    res.status(201).json({ ...rows[0], channel: notify.whatsappConfigured() ? 'whatsapp' : (b.email ? 'email' : 'whatsapp') });
  });

  // Oferta de mesa (enlace del aviso).
  router.get('/api/public/waitlist/:id', async (req, res) => {
    const { rows } = await db.query(`SELECT w.*, r.name AS restaurant_name, r.phone AS restaurant_phone,
        r.guarantee_enabled, r.guarantee_fee_cents, r.guarantee_free_cancel_hours
      FROM waitlist w JOIN restaurants r ON r.id = w.restaurant_id WHERE w.id = $1 AND w.access_key = $2`, [Number(req.params.id) || 0, String(req.query.k || '')]);
    const w = rows[0];
    if (!w) return res.status(404).json({ error: 'Este enlace no es válido.' });
    if (w.status === 'offered' && w.offer_expires_at < madridNow().stamp) {
      await processDay(w.restaurant_id, w.date, req);
      w.status = 'expired';
    }
    res.json({
      id: w.id, status: w.status, date: w.date, time: w.time, offerTime: w.offer_time, partySize: w.party_size,
      customerName: w.customer_name, phone: w.phone, email: w.email, offerExpiresAt: w.offer_expires_at,
      restaurant: { id: w.restaurant_id, name: w.restaurant_name, phone: w.restaurant_phone, guarantee_enabled: w.guarantee_enabled,
        guarantee_fee_cents: w.guarantee_fee_cents, guarantee_free_cancel_hours: w.guarantee_free_cancel_hours },
      nowMadrid: madridNow().stamp,
    });
  });

  router.post('/api/public/waitlist/:id/leave', async (req, res) => {
    const { rows } = await db.query(`UPDATE waitlist SET status = 'cancelled' WHERE id = $1 AND access_key = $2
      AND status IN ('waiting','offered') RETURNING restaurant_id, date`, [Number(req.params.id) || 0, String((req.body || {}).k || '')]);
    if (!rows[0]) return res.status(404).json({ error: 'No estás en la lista o el enlace no es válido.' });
    onReservationFreed(rows[0].restaurant_id, rows[0].date, req);
    res.json({ ok: true });
  });

  // --- Web de clientes: gestionar su reserva (enlace del recordatorio) ---------------
  async function manageRow(req) {
    const { rows } = await db.query(`SELECT res.*, r.name AS restaurant_name, r.phone AS restaurant_phone
      FROM reservations res JOIN restaurants r ON r.id = res.restaurant_id WHERE res.id = $1 AND res.manage_key = $2`,
    [Number(req.params.id) || 0, String(req.query.k || (req.body || {}).k || '')]);
    return rows[0] || null;
  }
  function publicReservation(r) {
    const start = `${r.date} ${r.time}`;
    const now = madridNow().stamp;
    const hoursLeft = (new Date(start.replace(' ', 'T') + ':00Z') - new Date(now.replace(' ', 'T') + 'Z')) / 3600000;
    const lateCancel = r.guarantee_status === 'ok' && hoursLeft < (r.guarantee_free_cancel_hours || 0);
    return {
      id: r.id, status: r.status, date: r.date, time: r.time, party_size: r.party_size, customer_name: r.customer_name,
      restaurant_name: r.restaurant_name, restaurant_phone: r.restaurant_phone, customer_confirmed_at: r.customer_confirmed_at,
      guarantee_status: r.guarantee_status, card_last4: r.card_last4,
      canChange: ['confirmed'].includes(r.status) && start > now.slice(0, 16),
      lateCancelPenaltyCents: lateCancel ? (r.guarantee_fee_cents || 0) * r.party_size : 0,
      freeCancelHours: r.guarantee_free_cancel_hours,
    };
  }
  router.get('/api/public/manage/:id', async (req, res) => {
    const r = await manageRow(req);
    if (!r) return res.status(404).json({ error: 'Este enlace no es válido.' });
    res.json(publicReservation(r));
  });
  router.post('/api/public/manage/:id/confirm', async (req, res) => {
    const r = await manageRow(req);
    if (!r) return res.status(404).json({ error: 'Este enlace no es válido.' });
    if (r.status !== 'confirmed') return res.status(409).json({ error: 'Esta reserva ya no está activa.' });
    await db.query('UPDATE reservations SET customer_confirmed_at = COALESCE(customer_confirmed_at, $2) WHERE id = $1', [r.id, madridNow().stamp]);
    res.json(publicReservation({ ...r, customer_confirmed_at: r.customer_confirmed_at || madridNow().stamp }));
  });
  router.post('/api/public/manage/:id/cancel', async (req, res) => {
    const r = await manageRow(req);
    if (!r) return res.status(404).json({ error: 'Este enlace no es válido.' });
    const pub = publicReservation(r);
    if (!pub.canChange) return res.status(409).json({ error: 'Esta reserva ya no se puede cancelar desde aquí. Llama al restaurante.' });
    await db.query(`UPDATE reservations SET status = 'cancelled', cancelled_by = 'customer',
      cancelled_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1 AND status = 'confirmed'`, [r.id]);
    audit.record({ user: null, restaurantId: r.restaurant_id, action: 'reserva.cancelar',
      summary: `Reserva #${r.id} ${r.customer_name} · ${r.party_size} pax · ${r.date} ${r.time} → Cancelada por el cliente (enlace del recordatorio)` });
    onReservationFreed(r.restaurant_id, r.date, req);
    res.json({ ...pub, status: 'cancelled', canChange: false });
  });

  // --- Panel ----------------------------------------------------------------------
  const staff = express.Router();
  staff.use(adminAuth.can('reservations'));
  staff.get('/', async (req, res) => {
    const restaurantId = Number(req.query.restaurantId);
    const date = String(req.query.date || '');
    if (!perms.canAccessRestaurant(req.user, restaurantId)) return res.status(403).json({ error: 'No tienes acceso a este local.' });
    if (date >= madridNow().date) await processDay(restaurantId, date, req);
    const { rows } = await db.query(`SELECT id, date, time, party_size, customer_name, phone, email, notes, source, status,
        offer_time, offered_at, offer_expires_at, reservation_id, created_at
      FROM waitlist WHERE restaurant_id = $1 AND date = $2 ORDER BY CASE status WHEN 'offered' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, created_at`,
    [restaurantId, date]);
    const ids = rows.map(r => r.id);
    const { rows: notes } = ids.length ? await db.query(`SELECT waitlist_id, channel, status, created_at FROM notifications
      WHERE waitlist_id = ANY($1::int[]) ORDER BY id`, [ids]) : { rows: [] };
    res.json({ entries: rows.map(r => ({ ...r, notifications: notes.filter(n => n.waitlist_id === r.id) })), offerMinutes: OFFER_MINUTES,
      whatsapp: notify.whatsappConfigured() });
  });
  staff.post('/', async (req, res) => {
    const b = req.body || {};
    const restaurantId = Number(b.restaurantId);
    if (!perms.canAccessRestaurant(req.user, restaurantId)) return res.status(403).json({ error: 'No tienes acceso a este local.' });
    const errors = validEntryInput(b);
    if (errors.length) return res.status(400).json({ error: errors[0] });
    const { rows } = await db.query(`INSERT INTO waitlist (restaurant_id, date, time, party_size, customer_name, phone, email, notes, source, access_key, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'panel',$9,$10) RETURNING *`,
    [restaurantId, b.date, b.time, Number(b.partySize), String(b.customerName).trim(), (b.phone || '').trim() || null,
      (b.email || '').trim() || null, (b.notes || '').trim() || null, newKey(), req.user.id]);
    audit.record({ user: req.user, restaurantId, action: 'reserva.lista_espera',
      summary: `Lista de espera: ${rows[0].customer_name} · ${rows[0].party_size} pax · ${rows[0].date} ${rows[0].time}` });
    onReservationFreed(restaurantId, b.date, req);
    res.status(201).json(rows[0]);
  });
  staff.patch('/:id', async (req, res) => {
    const { rows: cur } = await db.query('SELECT * FROM waitlist WHERE id = $1', [Number(req.params.id)]);
    const w = cur[0];
    if (!w) return res.status(404).json({ error: 'No encontrado' });
    if (!perms.canAccessRestaurant(req.user, w.restaurant_id)) return res.status(403).json({ error: 'No tienes acceso a este local.' });
    if ((req.body || {}).status !== 'cancelled') return res.status(400).json({ error: 'Solo se puede quitar de la lista.' });
    await db.query("UPDATE waitlist SET status = 'cancelled' WHERE id = $1 AND status IN ('waiting','offered','expired')", [w.id]);
    audit.record({ user: req.user, restaurantId: w.restaurant_id, action: 'reserva.lista_espera',
      summary: `Lista de espera: quitado ${w.customer_name} · ${w.date} ${w.time}` });
    onReservationFreed(w.restaurant_id, w.date, req);
    res.json({ ok: true });
  });
  // Avisar a mano (aunque el sistema no vea sitio: el encargado sabe que lo hay).
  staff.post('/:id/offer', async (req, res) => {
    const { rows: cur } = await db.query('SELECT * FROM waitlist WHERE id = $1', [Number(req.params.id)]);
    const w = cur[0];
    if (!w) return res.status(404).json({ error: 'No encontrado' });
    if (!perms.canAccessRestaurant(req.user, w.restaurant_id)) return res.status(403).json({ error: 'No tienes acceso a este local.' });
    if (!['waiting', 'expired'].includes(w.status)) return res.status(409).json({ error: 'Esta persona ya tiene una oferta activa o ya no está en la lista.' });
    const restaurant = await restaurantById(w.restaurant_id);
    const time = /^\d{2}:\d{2}$/.test((req.body || {}).time || '') ? req.body.time : ((await findOfferTime(restaurant, w)) || w.time);
    const result = await makeOffer(restaurant, w, time, req);
    audit.record({ user: req.user, restaurantId: w.restaurant_id, action: 'reserva.lista_espera',
      summary: `Lista de espera: aviso manual a ${w.customer_name} · ${w.date} ${time} (${result && result.sent ? result.sent.channel : 'sin enviar'})` });
    res.json({ ok: true, channel: result && result.sent && result.sent.channel });
  });
  router.use('/api/waitlist-admin', staff);

  // --- Procesos programados (GitHub Actions, como la encuesta) ----------------------
  function cronOk(req, res) {
    if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) { res.status(401).json({ error: 'No autorizado' }); return false; }
    return true;
  }
  // Recordatorio del día antes (una vez al día, por la tarde).
  router.get('/api/cron/send-reminders', async (req, res) => {
    if (!cronOk(req, res)) return;
    const today = madridNow().date;
    const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
    const tomorrow = d.toISOString().slice(0, 10);
    const { rows } = await db.query(`SELECT res.*, r.name AS r_name FROM reservations res JOIN restaurants r ON r.id = res.restaurant_id
      WHERE res.date = $1 AND res.status = 'confirmed' AND res.reminder_sent_at IS NULL AND res.source <> 'walkin'
        AND (res.phone IS NOT NULL OR res.email IS NOT NULL)`, [tomorrow]);
    const restaurants = {};
    const results = [];
    for (const r of rows) {
      restaurants[r.restaurant_id] = restaurants[r.restaurant_id] || await restaurantById(r.restaurant_id);
      r.manage_key = await ensureManageKey(r);
      const sent = await notify.sendReminder({ restaurant: restaurants[r.restaurant_id], reservation: r, baseUrl: baseUrl(req) });
      if (sent.ok) await db.query('UPDATE reservations SET reminder_sent_at = $2 WHERE id = $1', [r.id, madridNow().stamp]);
      results.push({ reservationId: r.id, ...sent });
    }
    res.json({ date: tomorrow, total: rows.length, sent: results.filter(r => r.ok).length, results });
  });
  // Cada pocos minutos: caduca ofertas y avisa al siguiente de la lista.
  router.get('/api/cron/waitlist-tick', async (req, res) => {
    if (!cronOk(req, res)) return;
    const { rows } = await db.query(`SELECT DISTINCT restaurant_id, date FROM waitlist
      WHERE status IN ('waiting','offered') AND date >= $1`, [madridNow().date]);
    let offers = 0;
    for (const r of rows) { if (await processDay(r.restaurant_id, r.date, req)) offers++; }
    res.json({ days: rows.length, offers });
  });

  return router;
}

module.exports = { makeRouter, processDay, onReservationFreed, markAccepted, ensureManageKey, OFFER_MINUTES };
