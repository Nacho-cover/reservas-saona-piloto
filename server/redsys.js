// Redsys (TPV virtual del banco) para la garantía con tarjeta de las reservas web.
//
// Flujo (decidido con Nacho el 15/10/2026):
//  1. Reserva web en un local con garantía activa → la reserva queda "pending_card" y
//     el navegador del cliente va a la pasarela de Redsys (Redirección, realizarPago).
//     Operación de importe 0 con DS_MERCHANT_IDENTIFIER=REQUIRED (pago por referencia):
//     no se cobra nada, Redsys autentica la tarjeta (3D Secure) y nos devuelve una
//     referencia (token). Nunca vemos ni guardamos el número de tarjeta.
//  2. Redsys avisa al servidor (DS_MERCHANT_MERCHANTURL) y devuelve al cliente a URLOK
//     o URLKO. Con respuesta 0000-0099 la reserva pasa a confirmada.
//  3. Si el cliente no viene o cancela fuera de plazo, un responsable pulsa "Cobrar
//     penalización": cobro iniciado por el comercio (MIT) por REST con la referencia,
//     DS_MERCHANT_COF_TYPE=N (No Show), DS_MERCHANT_EXCEP_SCA=MIT y DIRECTPAYMENT.
//
// Cada local puede tener su propio comercio Redsys (los franquiciados cobran en su
// cuenta). La clave de firma se guarda cifrada (AES-256-GCM con PAYMENTS_SECRET). Si un
// local no tiene comercio propio se usa el comercio de PRUEBAS público de Redsys (no
// mueve dinero), salvo que REDSYS_TEST_FALLBACK=off.
//
// Firma: HMAC_SHA256_V1 (clave = 3DES-CBC del número de pedido con la clave del comercio).
// Documentación: pagosonline.redsys.es (Tokenización CIT/MIT, Parámetros, Entornos de prueba).

const crypto = require('crypto');
const db = require('./db');

const URLS = {
  test: { redirect: 'https://sis-t.redsys.es:25443/sis/realizarPago', rest: 'https://sis-t.redsys.es:25443/sis/rest/trataPeticionREST' },
  live: { redirect: 'https://sis.redsys.es/sis/realizarPago', rest: 'https://sis.redsys.es/sis/rest/trataPeticionREST' },
};
// Comercio de pruebas genérico publicado por Redsys (no mueve dinero real).
const TEST_ACCOUNT = { merchantCode: '999008881', terminal: '001', secret: 'sq7HjrUOBfKmC576ILgskD5srU870gJ7', env: 'test', isPublicTest: true };

// --- Firma -------------------------------------------------------------------------
function b64encodeJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}
function b64decodeJson(str) {
  const norm = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(norm, 'base64').toString('utf8'));
}
function orderKey(secretB64, order) {
  const key = Buffer.from(secretB64, 'base64');
  const iv = Buffer.alloc(8, 0);
  const cipher = crypto.createCipheriv('des-ede3-cbc', key, iv);
  cipher.setAutoPadding(false);
  const data = Buffer.from(String(order), 'utf8');
  const padded = Buffer.concat([data, Buffer.alloc((8 - (data.length % 8)) % 8, 0)]);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}
function sign(secretB64, order, merchantParamsB64) {
  return crypto.createHmac('sha256', orderKey(secretB64, order)).update(merchantParamsB64).digest('base64');
}
// Redsys devuelve la firma en base64 "URL-safe"; se compara normalizando.
function sameSignature(a, b) {
  const n = (s) => String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const x = Buffer.from(n(a)); const y = Buffer.from(n(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// --- Cuentas por local (clave cifrada) ----------------------------------------------
function encKey() {
  const s = process.env.PAYMENTS_SECRET;
  return s ? crypto.createHash('sha256').update(s).digest() : null;
}
function encryptSecret(plain) {
  const key = encKey();
  if (!key) throw Object.assign(new Error('Falta la variable PAYMENTS_SECRET en Render para poder guardar claves de Redsys.'), { status: 400 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function decryptSecret(stored) {
  const key = encKey();
  if (!key || !stored) return null;
  const [iv, tag, enc] = stored.split('.').map(p => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

async function getAccount(restaurantId) {
  const { rows } = await db.query('SELECT * FROM payment_accounts WHERE restaurant_id = $1', [restaurantId]);
  const a = rows[0];
  if (a && a.merchant_code && a.secret_enc) {
    const secret = decryptSecret(a.secret_enc);
    if (secret) return { merchantCode: a.merchant_code, terminal: a.terminal || '001', secret, env: a.env === 'live' ? 'live' : 'test', isPublicTest: false };
    return null; // hay cuenta pero no se puede descifrar (falta PAYMENTS_SECRET): no se usa la de pruebas por error
  }
  if (process.env.REDSYS_TEST_FALLBACK === 'off') return null;
  return { ...TEST_ACCOUNT };
}

async function accountSummary(restaurantId) {
  const { rows } = await db.query('SELECT merchant_code, terminal, env, updated_at, secret_enc IS NOT NULL AS has_secret FROM payment_accounts WHERE restaurant_id = $1', [restaurantId]);
  const a = rows[0];
  const acc = await getAccount(restaurantId);
  return {
    configured: !!(a && a.merchant_code && a.has_secret),
    merchantCode: a ? a.merchant_code : null,
    terminal: a ? a.terminal : null,
    env: a ? a.env : null,
    updatedAt: a ? a.updated_at : null,
    usingPublicTest: !!(acc && acc.isPublicTest),
    usable: !!acc,
    canStoreSecrets: !!encKey(),
  };
}

// --- Pedidos ------------------------------------------------------------------------
// Redsys: 4 primeros caracteres numéricos, 4-12 en total, únicos por comercio.
function newOrder() {
  const digits = String(Date.now() % 1e8).padStart(8, '0');
  const rand = crypto.randomBytes(3).toString('hex').slice(0, 4);
  return digits + rand; // 12 caracteres
}

// --- 1. Guardar tarjeta (Redirección) ----------------------------------------------
function cardValidationForm({ account, order, reservation, restaurant, baseUrl, publicKey }) {
  const q = `r=${reservation.id}&k=${publicKey}`;
  const params = {
    DS_MERCHANT_AMOUNT: '0',
    DS_MERCHANT_ORDER: order,
    DS_MERCHANT_MERCHANTCODE: account.merchantCode,
    DS_MERCHANT_CURRENCY: '978',
    DS_MERCHANT_TRANSACTIONTYPE: '0',
    DS_MERCHANT_TERMINAL: account.terminal,
    DS_MERCHANT_IDENTIFIER: 'REQUIRED',
    DS_MERCHANT_COF_INI: 'S',
    DS_MERCHANT_COF_TYPE: 'N',
    DS_MERCHANT_MERCHANTURL: `${baseUrl}/api/redsys/notify`,
    DS_MERCHANT_URLOK: `${baseUrl}/api/redsys/return?res=ok&${q}`,
    DS_MERCHANT_URLKO: `${baseUrl}/api/redsys/return?res=ko&${q}`,
    DS_MERCHANT_PRODUCTDESCRIPTION: `Garantía reserva ${reservation.date} ${reservation.time}`.slice(0, 125),
    DS_MERCHANT_MERCHANTNAME: String(restaurant.name || 'Saona').slice(0, 25),
    DS_MERCHANT_TITULAR: String(reservation.customer_name || '').slice(0, 60),
    DS_MERCHANT_CONSUMERLANGUAGE: '001',
  };
  const merchantParams = b64encodeJson(params);
  return {
    url: URLS[account.env].redirect,
    fields: {
      Ds_SignatureVersion: 'HMAC_SHA256_V1',
      Ds_MerchantParameters: merchantParams,
      Ds_Signature: sign(account.secret, order, merchantParams),
    },
  };
}

// Respuesta de Redsys (notificación o vuelta del cliente): devuelve los parámetros si
// la firma es buena con la cuenta del local del pedido.
async function verifyResponse({ Ds_MerchantParameters, Ds_Signature }, findRestaurantIdByOrder) {
  if (!Ds_MerchantParameters || !Ds_Signature) return null;
  let p;
  try { p = b64decodeJson(Ds_MerchantParameters); } catch { return null; }
  const order = p.Ds_Order || p.DS_ORDER;
  if (!order) return null;
  const restaurantId = await findRestaurantIdByOrder(order);
  if (!restaurantId) return null;
  const account = await getAccount(restaurantId);
  if (!account) return null;
  const expected = sign(account.secret, order, Ds_MerchantParameters);
  if (!sameSignature(expected, Ds_Signature)) return null;
  return p;
}

function isAuthorized(dsResponse) {
  const n = Number(dsResponse);
  return Number.isInteger(n) && n >= 0 && n <= 99;
}

// --- 3. Cobro de la penalización (REST, MIT) ----------------------------------------
async function chargeNoShow({ account, order, amountCents, token, cofTxnid, description }) {
  const params = {
    DS_MERCHANT_AMOUNT: String(amountCents),
    DS_MERCHANT_ORDER: order,
    DS_MERCHANT_MERCHANTCODE: account.merchantCode,
    DS_MERCHANT_CURRENCY: '978',
    DS_MERCHANT_TRANSACTIONTYPE: '0',
    DS_MERCHANT_TERMINAL: account.terminal,
    DS_MERCHANT_IDENTIFIER: token,
    DS_MERCHANT_COF_INI: 'N',
    DS_MERCHANT_COF_TYPE: 'N',
    DS_MERCHANT_EXCEP_SCA: 'MIT',
    DS_MERCHANT_DIRECTPAYMENT: 'true',
    DS_MERCHANT_PRODUCTDESCRIPTION: String(description || 'Penalización reserva').slice(0, 125),
  };
  if (cofTxnid) params.DS_MERCHANT_COF_TXNID = cofTxnid;
  const merchantParams = b64encodeJson(params);
  const body = { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: merchantParams, Ds_Signature: sign(account.secret, order, merchantParams) };
  const url = process.env.REDSYS_REST_URL || URLS[account.env].rest;
  let res, data;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    data = await res.json();
  } catch (err) {
    return { ok: false, error: `No se pudo contactar con Redsys (${err.message}). No se ha cobrado nada.` };
  }
  if (data.errorCode) return { ok: false, error: `Redsys rechazó la petición (${data.errorCode}).`, raw: data };
  if (!data.Ds_MerchantParameters || !sameSignature(sign(account.secret, order, data.Ds_MerchantParameters), data.Ds_Signature)) {
    return { ok: false, error: 'La respuesta de Redsys no tiene una firma válida.', raw: data };
  }
  const p = b64decodeJson(data.Ds_MerchantParameters);
  const ok = isAuthorized(p.Ds_Response);
  return { ok, response: p.Ds_Response, authCode: p.Ds_AuthorisationCode || null, params: p,
    error: ok ? null : `Cobro denegado por el banco (código ${p.Ds_Response}).` };
}

module.exports = {
  TEST_ACCOUNT, URLS, sign, b64encodeJson, b64decodeJson, sameSignature,
  encryptSecret, getAccount, accountSummary, newOrder, cardValidationForm, verifyResponse, isAuthorized, chargeNoShow,
};
