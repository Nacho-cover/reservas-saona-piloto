// Avisos al cliente: recordatorio del día antes y oferta de mesa de la lista de espera.
//
// Canal (decidido con Nacho el 15/10/2026): WhatsApp, con plantillas aprobadas por Meta
// (WhatsApp Cloud API). Mientras WhatsApp no esté configurado en Render, o si el envío
// falla, se manda por email (Resend, ver email.js) si el cliente dejó email. Cada aviso
// queda registrado en la tabla notifications (el panel muestra "WhatsApp enviado 20:01").
//
// Variables de entorno (Render):
//   WHATSAPP_TOKEN            token de acceso permanente (usuario del sistema de Meta Business)
//   WHATSAPP_PHONE_NUMBER_ID  id del número de WhatsApp Business que envía
//   WHATSAPP_API_VERSION      opcional, por defecto v22.0
//   WHATSAPP_LANG             opcional, idioma de las plantillas, por defecto es_ES
//   WHATSAPP_TEMPLATE_REMINDER / WHATSAPP_TEMPLATE_WAITLIST  opcional, nombres de plantilla
//     (por defecto saona_recordatorio_reserva y saona_lista_espera_mesa)
//   WHATSAPP_API_URL          solo pruebas: sustituye https://graph.facebook.com
//
// Las plantillas llevan un botón de enlace con parte variable: /r/{{1}} (gestionar la
// reserva) y /l/{{1}} (aceptar la mesa ofrecida). Ver docs/whatsapp-plantillas.md.

const db = require('./db');
const { sendEmail, formatFechaLarga } = require('./email');
// Escapa texto de usuario antes de meterlo en el HTML del email (auditoría 17/10, H-09).
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TEMPLATES = {
  reminder: process.env.WHATSAPP_TEMPLATE_REMINDER || 'saona_recordatorio_reserva',
  waitlist: process.env.WHATSAPP_TEMPLATE_WAITLIST || 'saona_lista_espera_mesa',
};

function whatsappConfigured() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

// Número en formato internacional sin "+" (lo que pide WhatsApp). Un móvil español de 9
// cifras recibe el 34 delante.
function waNumber(phone) {
  let d = String(phone || '').replace(/[^0-9]/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (/^[6789][0-9]{8}$/.test(d)) d = '34' + d;
  return d.length >= 10 ? d : null;
}

async function log(entry) {
  try {
    await db.query(`INSERT INTO notifications (restaurant_id, reservation_id, waitlist_id, kind, channel, recipient, status, provider_id, error)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [entry.restaurantId || null, entry.reservationId || null, entry.waitlistId || null, entry.kind, entry.channel,
      entry.recipient || null, entry.status, entry.providerId || null, entry.error ? String(entry.error).slice(0, 500) : null]);
  } catch (err) { console.error('[avisos] no se pudo registrar:', err.message); }
}

async function sendWhatsAppTemplate({ to, template, bodyParams, buttonSuffix }) {
  const version = process.env.WHATSAPP_API_VERSION || 'v22.0';
  const base = (process.env.WHATSAPP_API_URL || 'https://graph.facebook.com').replace(/\/$/, '');
  const components = [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) }];
  if (buttonSuffix) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(buttonSuffix) }] });
  const body = {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name: template, language: { code: process.env.WHATSAPP_LANG || 'es_ES' }, components },
  };
  try {
    const res = await fetch(`${base}/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data.error && (data.error.message || data.error.code)) || `HTTP ${res.status}` };
    return { ok: true, id: data.messages && data.messages[0] && data.messages[0].id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function fechaCorta(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

function emailShell({ restaurant, title, intro, rows, buttonUrl, buttonText, outro }) {
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#f4f2ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:24px 16px;">
    <div style="background:#152b4e;color:#fff;border-radius:12px 12px 0 0;padding:20px 24px;">
      <div style="font-size:12px;letter-spacing:4px;font-weight:700;color:#7a99ac;margin-bottom:8px;">SAONA</div>
      <div style="font-family:Georgia,serif;font-style:italic;font-size:22px;">${escHtml(restaurant.name)}</div>
      <div style="font-size:13px;opacity:0.85;">${title}</div>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:24px;border:1px solid #e1ded5;border-top:none;">
      <p style="margin:0 0 16px;font-size:15px;color:#384049;">${intro}</p>
      <div style="background:#f4f2ec;border-radius:10px;padding:16px 18px;margin-bottom:20px;">
        ${rows.map(r => `<p style="margin:0 0 4px;color:#65728A;font-size:14px;">${r}</p>`).join('')}
      </div>
      <a href="${buttonUrl}" style="display:block;text-align:center;background:#d3011d;color:#fff;text-decoration:none;font-weight:700;padding:14px;border-radius:10px;font-size:15px;">${buttonText}</a>
      <p style="margin:18px 0 0;font-size:13px;color:#65728A;">${outro}</p>
    </div>
  </div>
</body></html>`;
}

// Envía por WhatsApp y, si no se puede, por email. Devuelve el canal usado.
async function deliver({ kind, restaurant, reservationId, waitlistId, phone, email, wa, mail }) {
  const to = waNumber(phone);
  if (whatsappConfigured() && to) {
    const r = await sendWhatsAppTemplate({ to, ...wa });
    await log({ restaurantId: restaurant.id, reservationId, waitlistId, kind, channel: 'whatsapp', recipient: to, status: r.ok ? 'sent' : 'failed', providerId: r.id, error: r.error });
    if (r.ok) return { ok: true, channel: 'whatsapp' };
  }
  if (email) {
    const r = await sendEmail({ to: email, subject: mail.subject, html: mail.html });
    const ok = !!(r && (r.ok || r.skipped));
    await log({ restaurantId: restaurant.id, reservationId, waitlistId, kind, channel: 'email', recipient: email,
      status: r && r.ok ? 'sent' : (r && r.skipped ? 'skipped' : 'failed'), providerId: r && r.id, error: r && (r.error ? JSON.stringify(r.error) : r.skipped) });
    return { ok, channel: 'email' };
  }
  await log({ restaurantId: restaurant.id, reservationId, waitlistId, kind, channel: 'none', recipient: phone || null, status: 'failed', error: 'Sin WhatsApp configurado ni email del cliente' });
  return { ok: false, channel: 'none' };
}

async function sendReminder({ restaurant, reservation, baseUrl }) {
  const token = `${reservation.id}-${reservation.manage_key}`;
  const url = `${baseUrl}/r/${token}`;
  const fecha = fechaCorta(reservation.date);
  return deliver({
    kind: 'reminder', restaurant, reservationId: reservation.id, phone: reservation.phone, email: reservation.email,
    wa: { template: TEMPLATES.reminder, bodyParams: [reservation.customer_name, restaurant.name, fecha, reservation.time, reservation.party_size], buttonSuffix: token },
    mail: {
      subject: `Recordatorio: tu reserva mañana en ${restaurant.name}`,
      html: emailShell({
        restaurant, title: 'Recordatorio de tu reserva',
        intro: `Hola ${escHtml(reservation.customer_name)}, te esperamos mañana. ¿Nos confirmas que vienes?`,
        rows: [`📅 ${formatFechaLarga(reservation.date)}`, `🕐 ${reservation.time}h`, `👥 ${reservation.party_size} personas`],
        buttonUrl: url, buttonText: 'Confirmar o cancelar mi reserva',
        outro: 'Si no puedes venir, cancélala desde el enlace para que otra persona pueda disfrutar de la mesa.',
      }),
    },
  });
}

async function sendWaitlistOffer({ restaurant, entry, baseUrl, minutes }) {
  const token = `${entry.id}-${entry.access_key}`;
  const url = `${baseUrl}/l/${token}`;
  const fecha = fechaCorta(entry.date);
  return deliver({
    kind: 'waitlist_offer', restaurant, waitlistId: entry.id, phone: entry.phone, email: entry.email,
    wa: { template: TEMPLATES.waitlist, bodyParams: [entry.customer_name, restaurant.name, fecha, entry.offer_time, entry.party_size, minutes], buttonSuffix: token },
    mail: {
      subject: `¡Se ha liberado una mesa en ${restaurant.name}!`,
      html: emailShell({
        restaurant, title: 'Lista de espera',
        intro: `Hola ${escHtml(entry.customer_name)}, ¡se ha liberado una mesa para ti!`,
        rows: [`📅 ${formatFechaLarga(entry.date)}`, `🕐 ${entry.offer_time}h`, `👥 ${entry.party_size} personas`],
        buttonUrl: url, buttonText: 'Confirmar la mesa',
        outro: `Tienes ${minutes} minutos para confirmarla; después se ofrecerá a la siguiente persona de la lista.`,
      }),
    },
  });
}

module.exports = { whatsappConfigured, waNumber, sendReminder, sendWaitlistOffer, TEMPLATES };
