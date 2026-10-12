// Enlaces de un solo uso para el acceso al panel: restablecer contraseña (desde el
// login) e invitación a un usuario nuevo (desde la pantalla de Usuarios).
//
// El enlace lleva un token aleatorio; en la base de datos solo se guarda su sha256,
// así que ni con acceso a la base de datos se puede usar un enlace ajeno. Cada token
// sirve una vez y caduca (1 hora para restablecer, 7 días para invitaciones).

const crypto = require('crypto');
const db = require('./db');
const { sendEmail } = require('./email');

const TTL = { reset: 60 * 60 * 1000, invite: 7 * 24 * 60 * 60 * 1000 };

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function createToken(userId, purpose) {
  const token = crypto.randomBytes(32).toString('base64url');
  // Un enlace nuevo anula los anteriores sin usar del mismo usuario.
  await db.query('UPDATE password_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await db.query(
    'INSERT INTO password_tokens (user_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, $4)',
    [userId, sha(token), purpose, new Date(Date.now() + TTL[purpose])]);
  return token;
}

// Devuelve { tokenRow, user } si el token es válido (sin usar y sin caducar).
async function findValidToken(token) {
  if (!token || typeof token !== 'string') return null;
  const { rows } = await db.query(`
    SELECT t.id AS token_id, t.purpose, u.id, u.email, u.name, u.active
      FROM password_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`, [sha(token)]);
  if (!rows.length || !rows[0].active) return null;
  return rows[0];
}

async function markUsed(tokenId) {
  await db.query('UPDATE password_tokens SET used_at = now() WHERE id = $1', [tokenId]);
}

function baseUrl(req) {
  return (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#f4f2ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:24px 16px;">
    <div style="background:#152b4e;color:#fff;border-radius:12px 12px 0 0;padding:20px 24px;">
      <div style="font-size:12px;letter-spacing:4px;font-weight:700;color:#7a99ac;margin-bottom:8px;">SAONA</div>
      <div style="font-family:Georgia,serif;font-style:italic;font-size:22px;">${esc(title)}</div>
      <div style="font-size:13px;opacity:0.85;">Panel de reservas</div>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:24px;border:1px solid #e1ded5;border-top:none;font-size:15px;color:#384049;line-height:1.5;">
      ${bodyHtml}
    </div>
  </div>
</body></html>`;
}

function button(url, label) {
  return `<p style="margin:22px 0;"><a href="${esc(url)}" style="background:#d3011d;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;display:inline-block;">${esc(label)}</a></p>
  <p style="margin:0;font-size:12px;color:#65728A;">Si el botón no funciona, copia esta dirección en el navegador:<br><span style="word-break:break-all;">${esc(url)}</span></p>`;
}

async function sendResetEmail(req, user) {
  const token = await createToken(user.id, 'reset');
  const url = `${baseUrl(req)}/admin/restablecer.html?token=${token}`;
  return sendEmail({
    to: user.email,
    subject: 'Restablecer tu contraseña — Panel de reservas Saona',
    html: layout('Restablecer contraseña', `
      <p style="margin:0 0 12px;">Hola${user.name ? ' ' + esc(user.name) : ''},</p>
      <p style="margin:0;">Has pedido restablecer la contraseña del panel de reservas. Pulsa el botón para elegir una nueva. El enlace caduca en 1 hora y solo sirve una vez.</p>
      ${button(url, 'Elegir contraseña nueva')}
      <p style="margin:18px 0 0;font-size:13px;color:#65728A;">Si no lo has pedido tú, ignora este correo: tu contraseña no cambia.</p>`),
  });
}

async function sendInviteEmail(req, user, invitedBy) {
  const token = await createToken(user.id, 'invite');
  const url = `${baseUrl(req)}/admin/restablecer.html?token=${token}`;
  return sendEmail({
    to: user.email,
    subject: 'Tu acceso al panel de reservas de Saona',
    html: layout('Te damos acceso', `
      <p style="margin:0 0 12px;">Hola${user.name ? ' ' + esc(user.name) : ''},</p>
      <p style="margin:0;">${invitedBy ? esc(invitedBy) + ' te ha dado' : 'Tienes'} acceso al panel de reservas de Saona. Tu usuario es <strong>${esc(user.email)}</strong>. Pulsa el botón para elegir tu contraseña; el enlace caduca en 7 días.</p>
      ${button(url, 'Elegir mi contraseña')}`),
  });
}

module.exports = { createToken, findValidToken, markUsed, sendResetEmail, sendInviteEmail };
