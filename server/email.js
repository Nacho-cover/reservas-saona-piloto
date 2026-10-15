// Confirmación por email al reservar por la web, vía la API de Resend
// (https://resend.com). No añade ninguna librería nueva: es una llamada REST
// normal con fetch. Si no hay RESEND_API_KEY configurada, se avisa por consola
// y se sigue sin romper la reserva — el email es un extra, nunca debe bloquear
// que la reserva se guarde.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Reservas Saona <onboarding@resend.dev>';

function formatFechaLarga(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// Reserva garantizada con tarjeta: recordatorio de la política de cancelación.
function guaranteeLine(reservation) {
  if (reservation.guarantee_status !== 'ok' || !reservation.guarantee_fee_cents) return '';
  const perPerson = reservation.guarantee_fee_cents / 100;
  const total = perPerson * reservation.party_size;
  const fmt = (n) => n.toLocaleString('es-ES', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }) + ' €';
  const hours = reservation.guarantee_free_cancel_hours || 0;
  return `<div style="border:1px solid #e1ded5;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:13px;color:#384049;">
    💳 Reserva garantizada con tu tarjeta${reservation.card_last4 ? ' acabada en ' + reservation.card_last4 : ''}. No se ha cobrado nada.
    Si no puedes venir, avísanos con al menos <strong>${hours} h</strong> de antelación; si no te presentas o cancelas más tarde,
    se cobrarán <strong>${fmt(perPerson)} por persona</strong> (${fmt(total)} en total).</div>`;
}

function confirmationEmailHtml({ restaurant, reservation, zoneNames }) {
  const fecha = formatFechaLarga(reservation.date);
  const zonaLinea = zoneNames && zoneNames.length
    ? `<p style="margin:0 0 4px;color:#65728A;font-size:14px;">📍 Zona: <strong>${zoneNames.join(', ')}</strong></p>`
    : '';
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#f4f2ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:24px 16px;">
    <div style="background:#152b4e;color:#fff;border-radius:12px 12px 0 0;padding:20px 24px;">
      <div style="font-size:12px;letter-spacing:4px;font-weight:700;color:#7a99ac;margin-bottom:8px;">SAONA</div>
      <div style="font-family:Georgia,serif;font-style:italic;font-size:22px;">${restaurant.name}</div>
      <div style="font-size:13px;opacity:0.85;">Reserva confirmada</div>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:24px;border:1px solid #e1ded5;border-top:none;">
      <p style="margin:0 0 16px;font-size:15px;color:#384049;">Hola ${reservation.customer_name},</p>
      <p style="margin:0 0 20px;font-size:15px;color:#384049;">Tu reserva está confirmada. Aquí tienes los detalles:</p>
      <div style="background:#f4f2ec;border-radius:10px;padding:16px 18px;margin-bottom:20px;">
        <p style="margin:0 0 4px;color:#65728A;font-size:14px;">📅 Fecha: <strong style="color:#152b4e;">${fecha}</strong></p>
        <p style="margin:0 0 4px;color:#65728A;font-size:14px;">🕐 Hora: <strong style="color:#152b4e;">${reservation.time}h</strong></p>
        <p style="margin:0 0 4px;color:#65728A;font-size:14px;">👥 Comensales: <strong style="color:#152b4e;">${reservation.party_size}</strong></p>
        ${zonaLinea}
      </div>
      ${guaranteeLine(reservation)}
      <p style="margin:0 0 6px;font-size:13px;color:#65728A;">Si necesitas cambiar o cancelar tu reserva, llámanos:</p>
      <p style="margin:0 0 20px;font-size:15px;color:#384049;font-weight:600;">${restaurant.phone || ''}</p>
      <p style="margin:0;font-size:13px;color:#65728A;">${restaurant.address || ''}</p>
    </div>
  </div>
</body></html>`;
}

// Fase de pruebas: TODOS los emails de la app (confirmaciones y encuestas a clientes,
// invitaciones y restablecimientos de contraseña) se desvían a un único buzón, con el
// destinatario real indicado en el asunto y en una franja al principio del mensaje.
// Para enviar a los destinatarios reales, poner EMAIL_REDIRECT_TO=off en Render.
const REDIRECT_RAW = process.env.EMAIL_REDIRECT_TO;
const EMAIL_REDIRECT_TO = REDIRECT_RAW === undefined ? 'ngarcia@gruposaona.com'
  : (/^(off|no|false|0|)$/i.test(REDIRECT_RAW.trim()) ? null : REDIRECT_RAW.trim());

function redirectEmail({ to, subject, html }) {
  if (!EMAIL_REDIRECT_TO) return { to, subject, html };
  const original = Array.isArray(to) ? to.join(', ') : String(to);
  const safe = original.replace(/[<>&"]/g, '');
  const banner = `<div style="background:#fff3cd;color:#664d03;border-bottom:1px solid #e6d28a;padding:10px 16px;font:13px -apple-system,Segoe UI,Roboto,sans-serif;">
    <strong>Modo pruebas:</strong> este email iba dirigido a <strong>${safe}</strong> y se ha desviado a ${EMAIL_REDIRECT_TO}.</div>`;
  const withBanner = /<body[^>]*>/i.test(html) ? html.replace(/(<body[^>]*>)/i, `$1${banner}`) : banner + html;
  return { to: EMAIL_REDIRECT_TO, subject: `[Para: ${original}] ${subject}`, html: withBanner };
}

// Envío genérico vía Resend, reutilizado por la confirmación, la encuesta y los accesos.
async function sendEmail(message) {
  const { to, subject, html } = redirectEmail(message);
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY no configurada — no se envía el email:', subject);
    return { skipped: 'sin API key' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Error enviando email:', subject, data);
      return { error: data };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('Error de red enviando email:', subject, err.message);
    return { error: err.message };
  }
}

async function sendConfirmationEmail({ restaurant, reservation, zoneNames }) {
  if (!reservation.email) return { skipped: 'sin email' };
  return sendEmail({
    to: reservation.email,
    subject: `Reserva confirmada — ${restaurant.name}`,
    html: confirmationEmailHtml({ restaurant, reservation, zoneNames }),
  });
}

module.exports = { sendConfirmationEmail, sendEmail, formatFechaLarga, redirectEmail, EMAIL_REDIRECT_TO };
