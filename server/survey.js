// Encuesta de satisfacción del día después: token firmado (sin sesión de cliente,
// sin cuenta) para que el enlace del email sea válido pero no adivinable por nadie
// que no sea el propio destinatario.
const crypto = require('crypto');
const db = require('./db');
const { sendEmail, formatFechaLarga } = require('./email');

function getTokenSecret() {
  return db.prepare("SELECT value FROM app_secrets WHERE key = 'survey_token_secret'").get().value;
}

function generateSurveyToken(reservationId) {
  return crypto.createHmac('sha256', getTokenSecret()).update(String(reservationId)).digest('hex').slice(0, 32);
}

function verifySurveyToken(reservationId, token) {
  if (!token) return false;
  const expected = generateSurveyToken(reservationId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function surveyEmailHtml({ restaurant, reservation, surveyUrl }) {
  const fecha = formatFechaLarga(reservation.date);
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#f7f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:24px 16px;">
    <div style="background:#1f4d3a;color:#fff;border-radius:12px 12px 0 0;padding:20px 24px;">
      <div style="font-size:18px;font-weight:700;">${restaurant.name}</div>
      <div style="font-size:13px;opacity:0.85;">¿Qué tal tu visita?</div>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:24px;border:1px solid #e2e0da;border-top:none;">
      <p style="margin:0 0 16px;font-size:15px;color:#1c1c1c;">Hola ${reservation.customer_name},</p>
      <p style="margin:0 0 20px;font-size:15px;color:#1c1c1c;">
        Gracias por venir el ${fecha}. Nos encantaría saber qué tal lo pasaste — solo
        te llevará un minuto y nos ayuda muchísimo a mejorar.
      </p>
      <a href="${surveyUrl}" style="display:block;text-align:center;background:#1f4d3a;color:#fff;
        text-decoration:none;padding:14px 20px;border-radius:8px;font-weight:700;font-size:15px;">
        Valorar mi visita
      </a>
    </div>
  </div>
</body></html>`;
}

async function sendSurveyEmail({ restaurant, reservation, baseUrl }) {
  if (!reservation.email) return { skipped: 'sin email' };
  const token = generateSurveyToken(reservation.id);
  const surveyUrl = `${baseUrl}/encuesta.html?r=${reservation.id}&t=${token}`;
  return sendEmail({
    to: reservation.email,
    subject: `¿Qué tal tu visita a ${restaurant.name}?`,
    html: surveyEmailHtml({ restaurant, reservation, surveyUrl }),
  });
}

module.exports = { generateSurveyToken, verifySurveyToken, sendSurveyEmail };
