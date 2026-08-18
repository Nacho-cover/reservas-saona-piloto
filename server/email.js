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

function confirmationEmailHtml({ restaurant, reservation, zoneNames }) {
  const fecha = formatFechaLarga(reservation.date);
  const zonaLinea = zoneNames && zoneNames.length
    ? `<p style="margin:0 0 4px;color:#65728A;font-size:14px;">📍 Zona: <strong>${zoneNames.join(', ')}</strong></p>`
    : '';
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#f7f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:24px 16px;">
    <div style="background:#1f4d3a;color:#fff;border-radius:12px 12px 0 0;padding:20px 24px;">
      <div style="font-size:18px;font-weight:700;">${restaurant.name}</div>
      <div style="font-size:13px;opacity:0.85;">Reserva confirmada</div>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:24px;border:1px solid #e2e0da;border-top:none;">
      <p style="margin:0 0 16px;font-size:15px;color:#1c1c1c;">Hola ${reservation.customer_name},</p>
      <p style="margin:0 0 20px;font-size:15px;color:#1c1c1c;">Tu reserva está confirmada. Aquí tienes los detalles:</p>
      <div style="background:#f7f6f3;border-radius:10px;padding:16px 18px;margin-bottom:20px;">
        <p style="margin:0 0 4px;color:#65728A;font-size:14px;">📅 Fecha: <strong style="color:#163627;">${fecha}</strong></p>
        <p style="margin:0 0 4px;color:#65728A;font-size:14px;">🕐 Hora: <strong style="color:#163627;">${reservation.time}h</strong></p>
        <p style="margin:0 0 4px;color:#65728A;font-size:14px;">👥 Comensales: <strong style="color:#163627;">${reservation.party_size}</strong></p>
        ${zonaLinea}
      </div>
      <p style="margin:0 0 6px;font-size:13px;color:#65728A;">Si necesitas cambiar o cancelar tu reserva, llámanos:</p>
      <p style="margin:0 0 20px;font-size:15px;color:#1c1c1c;font-weight:600;">${restaurant.phone || ''}</p>
      <p style="margin:0;font-size:13px;color:#65728A;">${restaurant.address || ''}</p>
    </div>
  </div>
</body></html>`;
}

// Envío genérico vía Resend, reutilizado por la confirmación y por la encuesta.
async function sendEmail({ to, subject, html }) {
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

module.exports = { sendConfirmationEmail, sendEmail, formatFechaLarga };
