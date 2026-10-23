// Encuesta de satisfacción del día después: token firmado (sin sesión de cliente,
// sin cuenta) para que el enlace del email sea válido pero no adivinable por nadie
// que no sea el propio destinatario.
const crypto = require('crypto');
const db = require('./db');
const { sendEmail, formatFechaLarga } = require('./email');
// Escapa texto de usuario antes de meterlo en el HTML del email (auditoría 17/10, H-09).
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function getTokenSecret() {
  const { rows } = await db.query("SELECT value FROM app_secrets WHERE key = 'survey_token_secret'");
  return rows[0].value;
}

async function generateSurveyToken(reservationId) {
  const secret = await getTokenSecret();
  return crypto.createHmac('sha256', secret).update(String(reservationId)).digest('hex').slice(0, 32);
}

async function verifySurveyToken(reservationId, token) {
  if (!token) return false;
  const expected = await generateSurveyToken(reservationId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function surveyEmailHtml({ restaurant, reservation, surveyUrl }) {
  const fecha = formatFechaLarga(reservation.date);
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#f4f2ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:24px 16px;">
    <div style="background:#152b4e;color:#fff;border-radius:12px 12px 0 0;padding:20px 24px;">
      <div style="font-size:12px;letter-spacing:4px;font-weight:700;color:#7a99ac;margin-bottom:8px;">SAONA</div>
      <div style="font-family:Georgia,serif;font-style:italic;font-size:22px;">${escHtml(restaurant.name)}</div>
      <div style="font-size:13px;opacity:0.85;">¿Qué tal tu visita?</div>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:24px;border:1px solid #e1ded5;border-top:none;">
      <p style="margin:0 0 16px;font-size:15px;color:#384049;">Hola ${escHtml(reservation.customer_name)},</p>
      <p style="margin:0 0 20px;font-size:15px;color:#384049;">
        Gracias por venir el ${fecha}. Nos encantaría saber qué tal lo pasaste — solo
        te llevará un minuto y nos ayuda muchísimo a mejorar.
      </p>
      <a href="${surveyUrl}" style="display:block;text-align:center;background:#d3011d;color:#fff;
        text-decoration:none;padding:14px 20px;border-radius:8px;font-weight:700;font-size:15px;">
        Valorar mi visita
      </a>
    </div>
  </div>
</body></html>`;
}

async function sendSurveyEmail({ restaurant, reservation, baseUrl }) {
  if (!reservation.email) return { skipped: 'sin email' };
  const token = await generateSurveyToken(reservation.id);
  const surveyUrl = `${baseUrl}/encuesta.html?r=${reservation.id}&t=${token}`;
  return sendEmail({
    to: reservation.email,
    subject: `¿Qué tal tu visita a ${restaurant.name}?`,
    html: surveyEmailHtml({ restaurant, reservation, surveyUrl }),
  });
}

module.exports = { generateSurveyToken, verifySurveyToken, sendSurveyEmail };
