// Compartido por admin/index.html, config.html, horarios.html e informes.html: comprueba
// la sesión antes de dejar ver nada del panel, pinta el botón de cerrar sesión /
// cambiar contraseña, y el selector de local (multi-restaurante).

// Local que está gestionando el personal ahora mismo — persistido en este navegador,
// no en la sesión del servidor, así que cada miembro del equipo puede tener elegido
// un local distinto en su propio ordenador/tablet. Por defecto el 1 (primer local
// sembrado) si nunca se ha elegido nada.
const ADMIN_RESTAURANT_KEY = 'saona_admin_restaurant_id';
function getRestaurantId() {
  return Number(localStorage.getItem(ADMIN_RESTAURANT_KEY)) || 1;
}

// Usuario con sesión: { user, permissions, restaurants, allRestaurants } (de /api/admin/me).
// Lo rellena guardAdminPage() antes de que cada pantalla pinte nada.
let CURRENT_USER = null;

function hasPerm(perm) {
  return !!CURRENT_USER && CURRENT_USER.permissions.includes(perm);
}

// Oculta lo que el rol no puede usar: cualquier elemento con data-perm="permiso".
// (El servidor lo comprueba igualmente; esto es solo para no enseñar botones inútiles.)
function applyPermissionVisibility(root = document) {
  root.querySelectorAll('[data-perm]').forEach(el => {
    if (!hasPerm(el.dataset.perm)) el.classList.add('hidden');
  });
}

// Pinta el selector de local en el topbar y recarga la página al cambiar — así no
// hay que reescribir cada fetch de cada pantalla para reaccionar en caliente, y de
// paso se refresca todo lo que dependía del local anterior (reservas, planos, etc.)
// Solo salen los locales del usuario.
async function renderRestaurantBar(container) {
  if (!container) return;
  const restaurants = CURRENT_USER ? CURRENT_USER.restaurants : [];
  if (restaurants.length <= 1) return; // con un solo local no tiene sentido mostrar el selector

  const current = getRestaurantId();
  const select = document.createElement('select');
  select.id = 'restaurantSelect';
  select.className = 'restaurant-select';
  for (const r of restaurants) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.name;
    if (r.id === current) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    localStorage.setItem(ADMIN_RESTAURANT_KEY, select.value);
    location.reload();
  });
  container.appendChild(select);
}

// Comprueba la sesión antes de dejar ver nada. Con `requiredPerm`, si el rol no tiene
// ese permiso vuelve al panel de reservas. Si el local guardado en este navegador no es
// de este usuario, pasa al primero de los suyos.
async function guardAdminPage(requiredPerm) {
  let res;
  try { res = await fetch('/api/admin/me'); } catch { return false; }
  if (res.status === 401) {
    location.href = '/admin/login.html?next=' + encodeURIComponent(location.pathname);
    return false;
  }
  if (!res.ok) return false;
  CURRENT_USER = await res.json();

  if (CURRENT_USER.user.mustChangePassword) {
    openChangePasswordModal({ forced: true });
    return false;
  }
  if (requiredPerm && !hasPerm(requiredPerm)) {
    location.href = '/admin/';
    return false;
  }
  const ids = CURRENT_USER.restaurants.map(r => r.id);
  if (!ids.length) {
    document.body.innerHTML = `<div class="login-wrap"><div class="login-card">
      <h1>Sin locales asignados</h1>
      <p class="admin-sub">Tu usuario no tiene ningún local asignado todavía. Pide a un administrador que te asigne uno.</p>
      <button class="btn btn-secondary" type="button" id="noLocalLogout">Cerrar sesión</button></div></div>`;
    document.getElementById('noLocalLogout').addEventListener('click', async () => {
      await fetch('/api/admin/logout', { method: 'POST' });
      location.href = '/admin/login.html';
    });
    return false;
  }
  if (!ids.includes(getRestaurantId())) {
    localStorage.setItem(ADMIN_RESTAURANT_KEY, ids[0]);
    location.reload();
    return false;
  }
  applyPermissionVisibility();
  return true;
}

function escapeAuthHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderSessionBar(container) {
  const u = CURRENT_USER ? CURRENT_USER.user : null;
  container.innerHTML = `
    <div class="session-bar">
      ${u ? `<span class="session-user" title="${escapeAuthHtml(u.email)}">${escapeAuthHtml(u.name || u.email.split('@')[0])} · <strong>${escapeAuthHtml(u.roleLabel)}</strong></span>` : ''}
      ${hasPerm('reports') ? '<a class="btn-link" href="/admin/actividad.html">Actividad</a>' : ''}
      ${hasPerm('users') ? '<a class="btn-link" href="/admin/usuarios.html">Usuarios</a>' : ''}
      <button class="btn-link" id="changePassBtn" type="button">Cambiar contraseña</button>
      <button class="btn-link" id="logoutBtn" type="button">Cerrar sesión</button>
    </div>
  `;
  container.querySelector('#logoutBtn').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    location.href = '/admin/login.html';
  });
  container.querySelector('#changePassBtn').addEventListener('click', () => openChangePasswordModal());
}

// Con { forced: true } (contraseña provisional) no se puede cerrar: hay que cambiarla
// para seguir, y al guardarla se recarga la página ya con acceso normal.
function openChangePasswordModal({ forced = false } = {}) {
  let backdrop = document.getElementById('pwModalBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.id = 'pwModalBackdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h2 id="pwTitle">Cambiar contraseña</h2>
        <p class="cfg-hint" id="pwForcedHint"></p>
        <label class="field"><span id="pwCurrentLabel">Contraseña actual</span><input type="password" id="pwCurrent" autocomplete="current-password"></label>
        <label class="field"><span>Contraseña nueva (mínimo 8 caracteres)</span><input type="password" id="pwNew" autocomplete="new-password"></label>
        <label class="field"><span>Repite la contraseña nueva</span><input type="password" id="pwNew2" autocomplete="new-password"></label>
        <p class="error" id="pwError"></p>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="pwCancelBtn" type="button">Cancelar</button>
          <button class="btn btn-primary" id="pwSaveBtn" type="button">Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.querySelector('#pwCancelBtn').addEventListener('click', async () => {
      if (backdrop.dataset.forced === '1') {
        await fetch('/api/admin/logout', { method: 'POST' });
        location.href = '/admin/login.html';
        return;
      }
      backdrop.classList.add('hidden');
    });
    backdrop.querySelector('#pwSaveBtn').addEventListener('click', async () => {
      const currentPassword = backdrop.querySelector('#pwCurrent').value;
      const newPassword = backdrop.querySelector('#pwNew').value;
      const newPassword2 = backdrop.querySelector('#pwNew2').value;
      const errorEl = backdrop.querySelector('#pwError');
      errorEl.style.color = '';
      errorEl.textContent = '';
      if (newPassword !== newPassword2) { errorEl.textContent = 'Las dos contraseñas nuevas no coinciden.'; return; }
      try {
        const res = await fetch('/api/admin/change-password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo cambiar la contraseña');
        errorEl.style.color = 'var(--brand-dark)';
        errorEl.textContent = 'Contraseña actualizada.';
        if (backdrop.dataset.forced === '1') { setTimeout(() => location.reload(), 800); return; }
        setTimeout(() => backdrop.classList.add('hidden'), 1200);
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
  }
  backdrop.dataset.forced = forced ? '1' : '0';
  backdrop.querySelector('#pwTitle').textContent = forced ? 'Elige tu contraseña' : 'Cambiar contraseña';
  backdrop.querySelector('#pwForcedHint').textContent = forced
    ? 'Has entrado con una contraseña provisional. Elige una nueva para empezar a usar el panel.' : '';
  backdrop.querySelector('#pwCurrentLabel').textContent = forced ? 'Contraseña provisional' : 'Contraseña actual';
  backdrop.querySelector('#pwCancelBtn').textContent = forced ? 'Cerrar sesión' : 'Cancelar';
  ['#pwCurrent', '#pwNew', '#pwNew2'].forEach(sel => { backdrop.querySelector(sel).value = ''; });
  backdrop.querySelector('#pwError').textContent = '';
  backdrop.classList.remove('hidden');
}
