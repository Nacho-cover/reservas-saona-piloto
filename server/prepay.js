// Pago anticipado de reservas (Redsys). Ver también server/redsys.js y server/guarantee.js.
//
// Decisiones de Nacho (18/11/2026):
//  - Dos formas de pedir el pago: (1) el encargado crea un LINK DE PAGO desde la reserva en
//    el panel y se lo envía al cliente; (2) la web lo pide sola al reservar, en los locales
//    que lo activen y a partir de un número mínimo de comensales (el pago sustituye a la
//    tarjeta de garantía en esas reservas).
//  - Importe: euros por persona, fijados por local, × comensales.
//  - Devolución: "depende del plazo". Si la reserva se cancela con al menos N horas de
//    antelación (N por local, se guarda en la reserva al pedir el pago) o la cancela el
//    restaurante, el pago se puede devolver; si no, no. La devolución nunca es automática:
//    la confirma una persona con el permiso "penalties" pulsando «Devolver pago».
//
// Estados de prepay_status: 'pending' (pedido, sin pagar) · 'paid' (pagado).
// Devolución en prepay_refund_status: 'processing' · 'refunded' · 'failed'.

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const adminAuth = require('./adminAuth');
const perms = require('./permissions');
const audit = require('./audit');
const redsys = require('./redsys');
const { sendPayLinkEmail, EMAIL_REDIRECT_TO } = require('./email');

const ACTIVE_STATUSES = ['confirmed', 'pending_card'];

function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const proto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}
function euros(cents) {
  return ((cents || 0) / 100).toLocaleString('es-ES', { minimumFractionDigits: (cents || 0) % 100 ? 2 : 0, maximumFractionDigits: 2 }) + ' €';
}
function nowMadrid() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).replace('T', ' ').slice(0, 19);
}
function todayMadrid() { return nowMadrid().slice(0, 10); }

// ¿Se puede devolver el pago de esta reserva? (SQL, para la lista del día y la devolución)
// Pagada y cancelada, y: la cancela el restaurante, o el cliente con tiempo de sobra.
// cancelled_at se guarda en la hora de la sesión de la base de datos; la reserva, en hora de España.
const REFUND_ELIGIBLE_SQL = `(
  r.prepay_status = 'paid'
  AND COALESCE(r.prepay_refund_status, '') NOT IN ('refunded', 'processing')
  AND r.status = 'cancelled'
  AND (r.cancelled_by = 'restaurant' OR (
    r.cancelled_at IS NOT NULL
    AND (((r.date || ' ' || r.time)::timestamp AT TIME ZONE 'Europe/Madrid')
         - (r.cancelled_at::timestamp AT TIME ZONE current_setting('TimeZone')))
        >= make_interval(hours => COALESCE(r.prepay_refund_hours, 0))
  ))
)`;

// ¿Esta reserva web pide pago anticipado? (la decide el local: activado + mínimo de comensales)
function webNeedsPrepay(restaurant, partySize) {
  return !!(restaurant.prepay_web_enabled && Number(partySize) >= Number(restaurant.prepay_min_party || 1));
}
function amountFor(restaurant, partySize) {
  return (restaurant.prepay_fee_cents || 0) * Number(partySize);
}

// Deja la reserva con el pago pedido y devuelve la clave pública que va en el enlace.
async function markPending(reservation, restaurant) {
  const amount = amountFor(restaurant, reservation.party_size);
  const key = reservation.guarantee_key || reservation.prepay_key || crypto.randomBytes(16).toString('hex');
  await db.query(`UPDATE reservations SET prepay_status = 'pending', prepay_amount_cents = $2, prepay_key = $3, guarantee_key = $3,
      prepay_refund_hours = $4 WHERE id = $1 AND COALESCE(prepay_status, '') <> 'paid'`,
  [reservation.id, amount, key, restaurant.prepay_refund_hours]);
  return { key, amount };
}

// Nuevo intento de pago: un número de pedido nuevo (Redsys no admite repetirlos).
async function startAttempt(req, restaurant, reservation, key, amount) {
  const account = await redsys.getAccount(restaurant.id);
  if (!account) throw Object.assign(new Error('Ahora mismo no podemos cobrar el pago anticipado. Llama al restaurante.'), { status: 503 });
  const order = redsys.newOrder();
  await db.query('INSERT INTO prepay_attempts (order_no, reservation_id, created_at) VALUES ($1, $2, $3)', [order, reservation.id, nowMadrid()]);
  await db.query("UPDATE reservations SET prepay_order = $2 WHERE id = $1 AND prepay_status = 'pending'", [reservation.id, order]);
  const form = redsys.paymentForm({ account, order, amountCents: amount, reservation, restaurant, baseUrl: baseUrl(req), publicKey: key });
  return { form, testMode: account.env === 'test' };
}

// Alta de una reserva WEB que pide pago anticipado (lo llama POST /api/reservations).
async function startForReservation(req, restaurant, reservation) {
  const { key, amount } = await markPending(reservation, restaurant);
  const started = await startAttempt(req, restaurant, reservation, key, amount);
  return { ...started, amountCents: amount };
}

// Resultado de Redsys (notificación del servidor o vuelta del cliente). Idempotente.
async function applyResult(params, { onPaid } = {}) {
  const p = await redsys.verifyResponse(params, async (order) => {
    const { rows } = await db.query(`SELECT r.restaurant_id FROM prepay_attempts a JOIN reservations r ON r.id = a.reservation_id
      WHERE a.order_no = $1`, [order]);
    return rows[0] ? rows[0].restaurant_id : null;
  });
  if (!p) return { valid: false };
  const { rows } = await db.query(`SELECT r.* FROM prepay_attempts a JOIN reservations r ON r.id = a.reservation_id
    WHERE a.order_no = $1`, [p.Ds_Order]);
  const r = rows[0];
  if (!r) {
    if (redsys.isAuthorized(p.Ds_Response)) console.error(`[pago anticipado] pago autorizado (pedido ${p.Ds_Order}) de una reserva que ya no existe. Hay que devolverlo.`);
    return { valid: true, found: false };
  }
  if (r.prepay_status === 'paid') {
    if (redsys.isAuthorized(p.Ds_Response) && p.Ds_Order !== r.prepay_order) {
      console.error(`[pago anticipado] reserva ${r.id}: SEGUNDO pago autorizado (pedido ${p.Ds_Order}); el pagado es ${r.prepay_order}. Hay que devolver uno.`);
    }
    return { valid: true, found: true, reservation: r, already: true };
  }
  if (redsys.isAuthorized(p.Ds_Response)) {
    if (Number(p.Ds_Amount) !== Number(r.prepay_amount_cents)) {
      // El banco cobró un importe distinto al pedido: no se da por pagada, que lo revise una persona.
      console.error(`[pago anticipado] reserva ${r.id}: importe cobrado ${p.Ds_Amount} ≠ pedido ${r.prepay_amount_cents}`);
      return { valid: true, found: true, mismatch: true };
    }
    const { rows: upd } = await db.query(`
      UPDATE reservations SET prepay_status = 'paid', prepay_order = $2, prepay_paid_at = $3, prepay_auth_code = $4,
             status = CASE WHEN status = 'pending_card' THEN 'confirmed' ELSE status END
       WHERE id = $1 AND prepay_status = 'pending' RETURNING *`,
    [r.id, p.Ds_Order, nowMadrid(), p.Ds_AuthorisationCode || null]);
    if (upd[0] && onPaid) await onPaid(upd[0]);
    return { valid: true, found: true, reservation: upd[0] || r, paid: true };
  }
  // Pago rechazado o abandonado. Una reserva web que solo existía para este pago se libera;
  // una reserva del personal con link sigue en pie y el link se puede volver a usar.
  if (r.status === 'pending_card') {
    await db.query('DELETE FROM reservation_tables WHERE reservation_id = $1', [r.id]);
    await db.query("DELETE FROM reservations WHERE id = $1 AND status = 'pending_card'", [r.id]);
  }
  return { valid: true, found: true, failed: true, response: p.Ds_Response };
}

// Enlace corto del link de pago: /p/ID-CLAVE (se monta en la raíz, no en /api).
function makePublicRouter() {
  const router = express.Router();
  router.get('/p/:token', async (req, res) => {
    const m = /^(\d+)-([a-f0-9]{32})$/.exec(String(req.params.token || ''));
    const { rows } = m ? await db.query('SELECT restaurant_id FROM reservations WHERE id = $1 AND prepay_key = $2', [Number(m[1]), m[2]]) : { rows: [] };
    if (!rows[0]) return res.redirect(303, '/?enlace=caducado');
    res.redirect(303, `/?restaurantId=${rows[0].restaurant_id}&pagar=${m[1]}&k=${m[2]}`);
  });
  return router;
}

function makeRouter({ sendConfirmation }) {
  const router = express.Router();
  const onPaid = (r) => { if (r.email) return sendConfirmation(r).catch(() => {}); };

  // Notificación servidor a servidor de Redsys (DS_MERCHANT_MERCHANTURL).
  router.post('/redsys/prepay-notify', express.urlencoded({ extended: false }), async (req, res) => {
    const result = await applyResult(req.body || {}, { onPaid });
    if (!result.valid) console.warn('[pago anticipado] notificación de Redsys con firma no válida');
    res.send('OK');
  });

  // Vuelta del cliente desde la pasarela (URLOK / URLKO).
  router.get('/redsys/prepay-return', async (req, res) => {
    const { r, k, res: outcome } = req.query;
    if (req.query.Ds_MerchantParameters) {
      await applyResult({ Ds_MerchantParameters: req.query.Ds_MerchantParameters, Ds_Signature: req.query.Ds_Signature }, { onPaid });
    }
    const { rows } = await db.query('SELECT restaurant_id, status FROM reservations WHERE id = $1 AND prepay_key = $2', [Number(r) || 0, String(k || '')]);
    if (outcome !== 'ok' && rows[0] && rows[0].status === 'pending_card') {
      await db.query('DELETE FROM reservation_tables WHERE reservation_id = $1', [Number(r)]);
      await db.query("DELETE FROM reservations WHERE id = $1 AND status = 'pending_card'", [Number(r)]);
    }
    const q = new URLSearchParams({ reserva: String(Number(r) || ''), k: String(k || ''), pago: outcome === 'ok' ? 'ok' : 'ko' });
    if (rows[0]) q.set('restaurantId', rows[0].restaurant_id);
    res.redirect(303, `/?${q.toString()}`);
  });

  // Datos de la página del link de pago (con la clave privada del enlace).
  router.get('/public/prepay/:id', async (req, res) => {
    const { rows } = await db.query(`
      SELECT r.id, r.status, r.date, r.time, r.party_size, r.customer_name, r.prepay_status, r.prepay_amount_cents,
             r.prepay_refund_hours, r.restaurant_id, rest.name AS restaurant_name, rest.phone AS restaurant_phone
        FROM reservations r JOIN restaurants rest ON rest.id = r.restaurant_id
       WHERE r.id = $1 AND r.prepay_key = $2`, [Number(req.params.id) || 0, String(req.query.k || '')]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Este enlace de pago no es válido.' });
    const payable = r.prepay_status === 'pending' && ACTIVE_STATUSES.includes(r.status) && r.date >= todayMadrid();
    res.json({ ...r, payable });
  });

  // El cliente pulsa «Pagar»: se prepara el formulario firmado para la pasarela.
  router.post('/public/prepay/:id/start', async (req, res) => {
    const { rows } = await db.query('SELECT * FROM reservations WHERE id = $1 AND prepay_key = $2', [Number(req.params.id) || 0, String((req.body || {}).k || '')]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Este enlace de pago no es válido.' });
    if (r.prepay_status === 'paid') return res.status(409).json({ error: 'Esta reserva ya está pagada.' });
    if (r.prepay_status !== 'pending' || !ACTIVE_STATUSES.includes(r.status) || r.date < todayMadrid()) {
      return res.status(409).json({ error: 'Este enlace de pago ya no está activo. Llama al restaurante.' });
    }
    const { rows: rest } = await db.query('SELECT * FROM restaurants WHERE id = $1', [r.restaurant_id]);
    try {
      const started = await startAttempt(req, rest[0], r, r.prepay_key, r.prepay_amount_cents);
      res.json({ redsys: started.form, testMode: started.testMode, amountCents: r.prepay_amount_cents });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // --- El encargado crea (o vuelve a copiar) el link de pago de una reserva ---------
  // Comprobaciones comunes a «crear/copiar link» y «enviar por email». Devuelve { error } o el contexto.
  async function linkContext(req) {
    const id = Number(req.params.id);
    const { rows } = await db.query('SELECT * FROM reservations WHERE id = $1', [id]);
    const r = rows[0];
    if (!r) return { error: [404, 'Reserva no encontrada'] };
    if (!perms.canAccessRestaurant(req.user, r.restaurant_id)) return { error: [403, 'No tienes acceso a este local.'] };
    const { rows: rest } = await db.query('SELECT * FROM restaurants WHERE id = $1', [r.restaurant_id]);
    const restaurant = rest[0];
    if (!restaurant.prepay_enabled) return { error: [409, 'El pago anticipado no está activado en este local (Horarios → Pago anticipado).'] };
    if (r.prepay_status === 'paid') return { error: [409, 'Esta reserva ya está pagada.'] };
    if (r.status !== 'confirmed') return { error: [409, 'Solo se puede pedir el pago de una reserva confirmada.'] };
    if (r.date < todayMadrid()) return { error: [409, 'La reserva ya ha pasado.'] };
    if (!(await redsys.getAccount(restaurant.id))) return { error: [503, 'El local no tiene un comercio de Redsys disponible.'] };
    const { key, amount } = await markPending(r, restaurant);
    return { r, restaurant, amount, url: `${baseUrl(req)}/p/${r.id}-${key}` };
  }

  router.post('/reservations/:id/prepay-link', adminAuth.can('reservations'), async (req, res) => {
    const c = await linkContext(req);
    if (c.error) return res.status(c.error[0]).json({ error: c.error[1] });
    const { r, restaurant, amount, url } = c;
    audit.record({ user: req.user, restaurantId: r.restaurant_id, action: 'reserva.link_pago',
      summary: `Reserva #${r.id} ${r.customer_name} · ${r.date} ${r.time}: link de pago de ${euros(amount)} (${euros(restaurant.prepay_fee_cents)} × ${r.party_size})` });
    res.json({ url, amountCents: amount, refundHours: restaurant.prepay_refund_hours });
  });

  // El encargado pulsa «Enviar link por email»: se manda al email de la reserva (con el
  // modo pruebas de email activo, llega a la dirección de pruebas, no al cliente).
  router.post('/reservations/:id/prepay-link/email', adminAuth.can('reservations'), async (req, res) => {
    const c = await linkContext(req);
    if (c.error) return res.status(c.error[0]).json({ error: c.error[1] });
    const { r, restaurant, amount, url } = c;
    if (!r.email) return res.status(409).json({ error: 'Esta reserva no tiene email. Copia el link y envíaselo por WhatsApp.' });
    const sent = await sendPayLinkEmail({ restaurant, reservation: r, url, amountCents: amount, refundHours: restaurant.prepay_refund_hours });
    if (!sent.ok) {
      return res.status(502).json({ error: sent.skipped
        ? 'La web no puede enviar emails ahora mismo (falta la clave de Resend). Copia el link y envíaselo tú.'
        : 'No se ha podido enviar el email. Copia el link y envíaselo tú.' });
    }
    audit.record({ user: req.user, restaurantId: r.restaurant_id, action: 'reserva.link_pago_email',
      summary: `Reserva #${r.id} ${r.customer_name} · ${r.date} ${r.time}: link de pago de ${euros(amount)} enviado por email a ${r.email}${EMAIL_REDIRECT_TO ? ` (modo pruebas: llega a ${EMAIL_REDIRECT_TO})` : ''}` });
    res.json({ ok: true, to: r.email, redirectedTo: EMAIL_REDIRECT_TO || null, amountCents: amount });
  });

  // --- Devolver el pago -----------------------------------------------------------
  router.post('/reservations/:id/refund-prepay', adminAuth.can('penalties'), async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await db.query(`SELECT r.*, ${REFUND_ELIGIBLE_SQL} AS eligible FROM reservations r WHERE r.id = $1`, [id]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (!perms.canAccessRestaurant(req.user, r.restaurant_id)) return res.status(403).json({ error: 'No tienes acceso a este local.' });
    if (!r.eligible) {
      return res.status(409).json({ error: r.prepay_refund_status === 'refunded' ? 'Este pago ya se devolvió.'
        : 'Este pago no se puede devolver: tiene que estar pagado, la reserva cancelada, y cancelada por el restaurante o por el cliente con la antelación mínima.' });
    }
    const account = await redsys.getAccount(r.restaurant_id);
    if (!account) return res.status(503).json({ error: 'El local no tiene un comercio de Redsys disponible.' });
    // Se marca antes de llamar a Redsys para que dos clics seguidos no devuelvan dos veces.
    const { rowCount } = await db.query(`UPDATE reservations SET prepay_refund_status = 'processing', prepay_refund_by = $2
      WHERE id = $1 AND COALESCE(prepay_refund_status, '') NOT IN ('refunded', 'processing')`, [id, req.user.id]);
    if (!rowCount) return res.status(409).json({ error: 'Ya se está devolviendo este pago.' });
    const result = await redsys.refundPayment({ account, order: r.prepay_order, amountCents: r.prepay_amount_cents });
    const { rows: upd } = await db.query(`UPDATE reservations SET prepay_refund_status = $2, prepay_refund_at = $3, prepay_refund_message = $4
      WHERE id = $1 RETURNING *`, [id, result.ok ? 'refunded' : 'failed', nowMadrid(), result.ok ? null : result.error]);
    audit.record({ user: req.user, restaurantId: r.restaurant_id, action: 'reserva.devolucion_pago',
      summary: `Reserva #${r.id} ${r.customer_name} · ${r.date} ${r.time}: pago de ${euros(r.prepay_amount_cents)} ${result.ok ? 'DEVUELTO' : 'NO devuelto'}${result.ok ? '' : ' — ' + result.error}${account.env === 'test' ? ' (entorno de pruebas)' : ''}`,
      details: { order: r.prepay_order, amount: r.prepay_amount_cents, response: result.response } });
    if (!result.ok) return res.status(402).json({ error: result.error, reservation: upd[0] });
    res.json({ ok: true, amountCents: r.prepay_amount_cents, testMode: account.env === 'test', reservation: upd[0] });
  });

  // --- Configuración por local (pantalla Horarios) ----------------------------------
  router.get('/restaurants/:restaurantId/prepay', adminAuth.can('reservations'), async (req, res) => {
    const id = Number(req.params.restaurantId);
    if (!perms.canAccessRestaurant(req.user, id)) return res.status(403).json({ error: 'No tienes acceso a este local.' });
    const { rows } = await db.query(`SELECT prepay_enabled, prepay_web_enabled, prepay_fee_cents, prepay_min_party, prepay_refund_hours,
      guarantee_enabled FROM restaurants WHERE id = $1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Local no encontrado' });
    const a = rows[0];
    res.json({
      enabled: a.prepay_enabled, webEnabled: a.prepay_web_enabled, feeCents: a.prepay_fee_cents, minParty: a.prepay_min_party,
      refundHours: a.prepay_refund_hours, guaranteeEnabled: a.guarantee_enabled,
      account: await redsys.accountSummary(id),
      canEdit: perms.hasPermission(req.user, 'schedule'),
    });
  });

  router.put('/restaurants/:restaurantId/prepay', adminAuth.can('schedule'), async (req, res) => {
    const id = Number(req.params.restaurantId);
    if (!perms.canAccessRestaurant(req.user, id)) return res.status(403).json({ error: 'No tienes acceso a este local.' });
    const { enabled, webEnabled, feeEuros, minParty, refundHours } = req.body || {};
    const feeCents = Math.round(Number(feeEuros) * 100);
    const min = Number(minParty);
    const hours = Number(refundHours);
    if (!Number.isFinite(feeCents) || feeCents < 100 || feeCents > 50000) return res.status(400).json({ error: 'El importe por persona tiene que estar entre 1 € y 500 €.' });
    if (!Number.isInteger(min) || min < 1 || min > 200) return res.status(400).json({ error: 'El mínimo de comensales tiene que estar entre 1 y 200.' });
    if (!Number.isInteger(hours) || hours < 0 || hours > 720) return res.status(400).json({ error: 'Las horas para devolver el pago tienen que estar entre 0 y 720.' });
    const on = !!enabled || !!webEnabled;
    if (on && !(await redsys.getAccount(id))) return res.status(400).json({ error: 'Este local no tiene un comercio de Redsys que se pueda usar. Configúralo antes (Garantía con tarjeta → Comercio de Redsys).' });
    await db.query(`UPDATE restaurants SET prepay_enabled = $2, prepay_web_enabled = $3, prepay_fee_cents = $4, prepay_min_party = $5,
      prepay_refund_hours = $6 WHERE id = $1`, [id, !!enabled, !!webEnabled, feeCents, min, hours]);
    audit.record({ user: req.user, restaurantId: id, action: 'prepago.config',
      summary: `Pago anticipado · links desde el panel ${enabled ? 'SÍ' : 'no'} · web ${webEnabled ? `SÍ (desde ${min} comensales)` : 'no'} · ${euros(feeCents)} por persona · devolución hasta ${hours} h antes` });
    res.json({ ok: true });
  });

  return router;
}

module.exports = {
  makeRouter, makePublicRouter, startForReservation, webNeedsPrepay, REFUND_ELIGIBLE_SQL, euros,
};
