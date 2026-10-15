// Garantía con tarjeta de las reservas web (ver server/redsys.js para el detalle de
// Redsys). Aquí: rutas de vuelta/notificación de Redsys, estado público de la reserva
// para la web de clientes, configuración por local, cobro de la penalización y
// limpieza de las reservas que se quedaron sin tarjeta.
//
// Reglas (Nacho, 15/10/2026): se pide tarjeta en todas las reservas web de los locales
// que tengan la garantía activada; penalización = importe por persona × comensales; se
// puede cobrar si el cliente no se presentó (no-show) o canceló él con menos horas de
// antelación que las de cancelación gratuita; el cobro lo confirma una persona con el
// permiso "penalties" (Encargado o superior) desde el panel, nunca es automático.

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const adminAuth = require('./adminAuth');
const perms = require('./permissions');
const audit = require('./audit');
const redsys = require('./redsys');

const PENDING_MINUTES = 20;

function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const proto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}
function euros(cents) {
  return (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }) + ' €';
}
function nowMadrid() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).replace('T', ' ').slice(0, 19);
}

// Reservas web que se quedaron esperando la tarjeta: se borran a los 20 min para liberar
// la mesa (nunca llegaron a ser reservas: el cliente no completó la pasarela).
async function cleanupPending() {
  await db.query(`
    DELETE FROM reservation_tables WHERE reservation_id IN (
      SELECT id FROM reservations WHERE status = 'pending_card'
         AND created_at::timestamp < (now()::timestamp - interval '${PENDING_MINUTES} minutes'))`);
  await db.query(`
    DELETE FROM reservations WHERE status = 'pending_card'
       AND created_at::timestamp < (now()::timestamp - interval '${PENDING_MINUTES} minutes')`);
}
// Un nuevo intento del mismo cliente (mismo teléfono, local y día) libera el anterior
// que dejó a medias en la pasarela, para que no se bloquee su propia mesa.
async function releaseOwnPending(restaurantId, phone, date) {
  if (!phone) return;
  const { rows } = await db.query(`SELECT id FROM reservations WHERE status = 'pending_card' AND restaurant_id = $1 AND date = $2
      AND saona_norm_phone(phone) = saona_norm_phone($3)`, [restaurantId, date, phone]);
  for (const r of rows) {
    await db.query('DELETE FROM reservation_tables WHERE reservation_id = $1', [r.id]);
    await db.query("DELETE FROM reservations WHERE id = $1 AND status = 'pending_card'", [r.id]);
  }
}
let cleanupTimer = null;
function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => cleanupPending().catch(err => console.error('[garantía] limpieza:', err.message)), 5 * 60 * 1000);
  cleanupTimer.unref?.();
}

// ¿Se puede cobrar la penalización de esta reserva? (SQL, para la lista del día y el cobro)
// cancelled_at se guarda en la hora de la sesión de la base de datos; la reserva, en hora de España.
const PENALTY_ELIGIBLE_SQL = `(
  r.guarantee_status = 'ok' AND r.card_token IS NOT NULL
  AND COALESCE(r.penalty_status, '') NOT IN ('charged', 'processing')
  AND (r.status = 'no_show' OR (
    r.status = 'cancelled' AND r.cancelled_by = 'customer' AND r.cancelled_at IS NOT NULL
    AND (((r.date || ' ' || r.time)::timestamp AT TIME ZONE 'Europe/Madrid')
         - (r.cancelled_at::timestamp AT TIME ZONE current_setting('TimeZone')))
        < make_interval(hours => COALESCE(r.guarantee_free_cancel_hours, 0))
  ))
)`;

// --- Alta de una reserva web con garantía (lo llama POST /api/reservations) -------------
async function startForReservation(req, restaurant, reservation) {
  const account = await redsys.getAccount(restaurant.id);
  if (!account) throw Object.assign(new Error('Ahora mismo no podemos pedir la tarjeta de garantía. Llama al restaurante para reservar.'), { status: 503 });
  const order = redsys.newOrder();
  const key = crypto.randomBytes(16).toString('hex');
  await db.query(`
    UPDATE reservations SET guarantee_status = 'pending', guarantee_order = $2, guarantee_key = $3,
           guarantee_fee_cents = $4, guarantee_free_cancel_hours = $5
     WHERE id = $1`, [reservation.id, order, key, restaurant.guarantee_fee_cents, restaurant.guarantee_free_cancel_hours]);
  const form = redsys.cardValidationForm({ account, order, reservation, restaurant, baseUrl: baseUrl(req), publicKey: key });
  return { form, testMode: account.env === 'test' };
}

// Resultado de Redsys (notificación del servidor o vuelta del cliente). Idempotente.
async function applyRedsysResult(params, { onConfirmed } = {}) {
  const p = await redsys.verifyResponse(params, async (order) => {
    const { rows } = await db.query('SELECT restaurant_id FROM reservations WHERE guarantee_order = $1', [order]);
    return rows[0] ? rows[0].restaurant_id : null;
  });
  if (!p) return { valid: false };
  const order = p.Ds_Order;
  const { rows } = await db.query('SELECT * FROM reservations WHERE guarantee_order = $1', [order]);
  const r = rows[0];
  if (!r) return { valid: true, found: false };
  if (r.status !== 'pending_card') return { valid: true, found: true, reservation: r, already: true };
  if (redsys.isAuthorized(p.Ds_Response) && p.Ds_Merchant_Identifier) {
    const last4 = String(p.Ds_Card_Number || '').replace(/[^0-9]/g, '').slice(-4) || null;
    const { rows: upd } = await db.query(`
      UPDATE reservations SET status = 'confirmed', guarantee_status = 'ok', card_token = $2, card_cof_txnid = $3,
             card_expiry = $4, card_last4 = $5
       WHERE id = $1 AND status = 'pending_card' RETURNING *`,
    [r.id, p.Ds_Merchant_Identifier, p.Ds_Merchant_Cof_Txnid || null, p.Ds_ExpiryDate || null, last4]);
    if (upd[0] && onConfirmed) await onConfirmed(upd[0]);
    return { valid: true, found: true, reservation: upd[0] || r, confirmed: true };
  }
  // Tarjeta rechazada o pasarela abandonada con error: se libera la mesa.
  await db.query('DELETE FROM reservation_tables WHERE reservation_id = $1', [r.id]);
  await db.query("DELETE FROM reservations WHERE id = $1 AND status = 'pending_card'", [r.id]);
  return { valid: true, found: true, failed: true, response: p.Ds_Response };
}

function makeRouter({ sendConfirmation }) {
  const router = express.Router();
  const onConfirmed = (r) => sendConfirmation(r).catch(() => {});

  // Notificación servidor a servidor de Redsys (DS_MERCHANT_MERCHANTURL).
  router.post('/redsys/notify', express.urlencoded({ extended: false }), async (req, res) => {
    const result = await applyRedsysResult(req.body || {}, { onConfirmed });
    if (!result.valid) console.warn('[garantía] notificación de Redsys con firma no válida');
    res.send('OK');
  });

  // Vuelta del cliente desde la pasarela (URLOK / URLKO). Redsys añade los parámetros
  // firmados en la URL; se aplican por si la notificación aún no ha llegado.
  router.get('/redsys/return', async (req, res) => {
    const { r, k, res: outcome } = req.query;
    if (req.query.Ds_MerchantParameters) {
      await applyRedsysResult({ Ds_MerchantParameters: req.query.Ds_MerchantParameters, Ds_Signature: req.query.Ds_Signature }, { onConfirmed });
    }
    const { rows } = await db.query('SELECT restaurant_id, status FROM reservations WHERE id = $1 AND guarantee_key = $2', [Number(r) || 0, String(k || '')]);
    const restaurantId = rows[0] ? rows[0].restaurant_id : '';
    // Vuelta por URLKO (el cliente canceló en la pasarela o la tarjeta falló) y sin
    // confirmación de Redsys: la mesa se libera ya, sin esperar los 20 minutos.
    if (outcome !== 'ok' && rows[0] && rows[0].status === 'pending_card') {
      await db.query('DELETE FROM reservation_tables WHERE reservation_id = $1', [Number(r)]);
      await db.query("DELETE FROM reservations WHERE id = $1 AND status = 'pending_card'", [Number(r)]);
    }
    const q = new URLSearchParams({ reserva: String(Number(r) || ''), k: String(k || ''), pago: outcome === 'ok' ? 'ok' : 'ko' });
    if (restaurantId) q.set('restaurantId', restaurantId);
    res.redirect(303, `/?${q.toString()}`);
  });

  // Estado de una reserva para la web de clientes (con la clave privada de esa reserva).
  router.get('/public/reservations/:id', async (req, res) => {
    const { rows } = await db.query(`
      SELECT r.id, r.status, r.date, r.time, r.party_size, r.customer_name, r.guarantee_status,
             r.guarantee_fee_cents, r.guarantee_free_cancel_hours, r.card_last4, r.restaurant_id,
             rest.name AS restaurant_name, rest.phone AS restaurant_phone
        FROM reservations r JOIN restaurants rest ON rest.id = r.restaurant_id
       WHERE r.id = $1 AND r.guarantee_key = $2`, [Number(req.params.id) || 0, String(req.query.k || '')]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontramos la reserva. Puede que no se completara el paso de la tarjeta.' });
    const r = rows[0];
    const { rows: t } = await db.query(`
      SELECT tb.name, z.name AS zone FROM reservation_tables rt JOIN tables tb ON tb.id = rt.table_id
      LEFT JOIN zones z ON z.id = tb.zone_id WHERE rt.reservation_id = $1`, [r.id]);
    res.json({ ...r, tables: t.map(x => x.name), zoneNames: [...new Set(t.map(x => x.zone).filter(Boolean))] });
  });

  // --- Configuración por local (pantalla Horarios) ---------------------------------
  router.get('/restaurants/:restaurantId/guarantee', adminAuth.can('reservations'), async (req, res) => {
    const id = Number(req.params.restaurantId);
    if (!perms.canAccessRestaurant(req.user, id)) return res.status(403).json({ error: 'No tienes acceso a este local.' });
    const { rows } = await db.query('SELECT guarantee_enabled, guarantee_fee_cents, guarantee_free_cancel_hours FROM restaurants WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Local no encontrado' });
    res.json({
      enabled: rows[0].guarantee_enabled, feeCents: rows[0].guarantee_fee_cents, freeCancelHours: rows[0].guarantee_free_cancel_hours,
      account: await redsys.accountSummary(id),
      canEdit: perms.hasPermission(req.user, 'schedule'),
      canEditAccount: perms.hasPermission(req.user, 'users'),
    });
  });

  router.put('/restaurants/:restaurantId/guarantee', adminAuth.can('schedule'), async (req, res) => {
    const id = Number(req.params.restaurantId);
    if (!perms.canAccessRestaurant(req.user, id)) return res.status(403).json({ error: 'No tienes acceso a este local.' });
    const { enabled, feeEuros, freeCancelHours } = req.body || {};
    const feeCents = Math.round(Number(feeEuros) * 100);
    const hours = Number(freeCancelHours);
    if (!Number.isFinite(feeCents) || feeCents < 100 || feeCents > 50000) return res.status(400).json({ error: 'El importe por persona tiene que estar entre 1 € y 500 €.' });
    if (!Number.isInteger(hours) || hours < 0 || hours > 240) return res.status(400).json({ error: 'Las horas de cancelación gratuita tienen que estar entre 0 y 240.' });
    if (enabled && !(await redsys.getAccount(id))) return res.status(400).json({ error: 'Este local no tiene un comercio de Redsys que se pueda usar. Configúralo antes de activar la garantía.' });
    await db.query('UPDATE restaurants SET guarantee_enabled = $2, guarantee_fee_cents = $3, guarantee_free_cancel_hours = $4 WHERE id = $1',
      [id, !!enabled, feeCents, hours]);
    audit.record({ user: req.user, restaurantId: id, action: 'garantia.config',
      summary: `Garantía con tarjeta ${enabled ? 'activada' : 'desactivada'} · ${euros(feeCents)} por persona · cancelación gratuita hasta ${hours} h antes` });
    res.json({ ok: true });
  });

  router.put('/restaurants/:restaurantId/payment-account', adminAuth.can('users'), async (req, res) => {
    const id = Number(req.params.restaurantId);
    const { merchantCode, terminal, secret, env, remove } = req.body || {};
    if (remove) {
      await db.query('DELETE FROM payment_accounts WHERE restaurant_id = $1', [id]);
      audit.record({ user: req.user, restaurantId: id, action: 'garantia.comercio', summary: 'Comercio Redsys del local eliminado' });
      return res.json(await redsys.accountSummary(id));
    }
    if (!/^[0-9]{6,12}$/.test(String(merchantCode || ''))) return res.status(400).json({ error: 'El código de comercio (FUC) son solo números (normalmente 9).' });
    if (!/^[0-9]{1,3}$/.test(String(terminal || ''))) return res.status(400).json({ error: 'El terminal es un número de 1 a 3 cifras (normalmente 1).' });
    if (!['test', 'live'].includes(env)) return res.status(400).json({ error: 'Elige el entorno: pruebas o real.' });
    const { rows } = await db.query('SELECT secret_enc FROM payment_accounts WHERE restaurant_id = $1', [id]);
    let secretEnc = rows[0] ? rows[0].secret_enc : null;
    if (secret) {
      if (!/^[A-Za-z0-9+/=]{24,64}$/.test(secret.trim())) return res.status(400).json({ error: 'La clave de firma (SHA-256) no tiene el formato de Redsys.' });
      secretEnc = redsys.encryptSecret(secret.trim());
    }
    if (!secretEnc) return res.status(400).json({ error: 'Falta la clave de firma (SHA-256) del comercio.' });
    await db.query(`
      INSERT INTO payment_accounts (restaurant_id, merchant_code, terminal, secret_enc, env, updated_at, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (restaurant_id) DO UPDATE SET merchant_code = $2, terminal = $3, secret_enc = $4, env = $5, updated_at = $6, updated_by = $7`,
    [id, String(merchantCode), String(terminal).padStart(3, '0'), secretEnc, env, nowMadrid(), req.user.id]);
    audit.record({ user: req.user, restaurantId: id, action: 'garantia.comercio',
      summary: `Comercio Redsys del local: ${merchantCode} terminal ${terminal} (${env === 'live' ? 'real' : 'pruebas'})${secret ? ', clave cambiada' : ''}` });
    res.json(await redsys.accountSummary(id));
  });

  // --- Cobro de la penalización ----------------------------------------------------
  router.post('/reservations/:id/charge-penalty', adminAuth.can('penalties'), async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await db.query(`SELECT r.*, ${PENALTY_ELIGIBLE_SQL} AS eligible, rest.name AS restaurant_name
      FROM reservations r JOIN restaurants rest ON rest.id = r.restaurant_id WHERE r.id = $1`, [id]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (!perms.canAccessRestaurant(req.user, r.restaurant_id)) return res.status(403).json({ error: 'No tienes acceso a este local.' });
    if (!r.eligible) {
      return res.status(409).json({ error: r.penalty_status === 'charged' ? 'Esta penalización ya se cobró.'
        : 'Esta reserva no admite cobro: hace falta tarjeta de garantía y que sea un no-show o una cancelación del cliente fuera de plazo.' });
    }
    const account = await redsys.getAccount(r.restaurant_id);
    if (!account) return res.status(503).json({ error: 'El local no tiene un comercio de Redsys disponible.' });
    const amount = (r.guarantee_fee_cents || 0) * r.party_size;
    const order = redsys.newOrder();
    // Se marca antes de llamar a Redsys para que dos clics seguidos no cobren dos veces.
    const { rowCount } = await db.query(`UPDATE reservations SET penalty_status = 'processing', penalty_order = $2, penalty_amount_cents = $3, penalty_by = $4
      WHERE id = $1 AND COALESCE(penalty_status, '') NOT IN ('charged', 'processing')`, [id, order, amount, req.user.id]);
    if (!rowCount) return res.status(409).json({ error: 'Ya se está cobrando esta penalización.' });
    const result = await redsys.chargeNoShow({ account, order, amountCents: amount, token: r.card_token, cofTxnid: r.card_cof_txnid,
      description: `Penalización reserva ${r.date} ${r.time} · ${r.restaurant_name}` });
    const status = result.ok ? 'charged' : 'failed';
    const { rows: upd } = await db.query(`UPDATE reservations SET penalty_status = $2, penalty_at = $3, penalty_auth_code = $4, penalty_message = $5
      WHERE id = $1 RETURNING *`, [id, status, nowMadrid(), result.authCode || null, result.ok ? null : result.error]);
    audit.record({ user: req.user, restaurantId: r.restaurant_id, action: 'reserva.penalizacion',
      summary: `Reserva #${r.id} ${r.customer_name} · ${r.date} ${r.time}: penalización de ${euros(amount)} ${result.ok ? 'COBRADA' : 'NO cobrada'}${result.ok ? '' : ' — ' + result.error}${account.env === 'test' ? ' (entorno de pruebas)' : ''}`,
      details: { order, amount, response: result.response, authCode: result.authCode } });
    if (!result.ok) return res.status(402).json({ error: result.error, reservation: upd[0] });
    res.json({ ok: true, amountCents: amount, authCode: result.authCode, testMode: account.env === 'test', reservation: upd[0] });
  });

  return router;
}

module.exports = { makeRouter, startForReservation, cleanupPending, releaseOwnPending, startCleanup, PENALTY_ELIGIBLE_SQL, PENDING_MINUTES };
