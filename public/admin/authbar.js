// Compartido por admin/index.html, admin/config.html y admin/horarios.html: comprueba
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

// Pinta el selector de local en el topbar y recarga la página al cambiar — así no
// hay que reescribir cada fetch de cada pantalla para reaccionar en caliente, y de
// paso se refresca todo lo que dependía del local anterior (reservas, planos, etc.)
async function renderRestaurantBar(container) {
  if (!container) return;
  let restaurants = [];
  try {
    const res = await fetch('/api/restaurants');
    restaurants = res.ok ? await res.json() : [];
  } catch { /* si falla, se deja el selector vacío en vez de romper la página */ }
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

async function guardAdminPage() {
  const res = await fetch('/api/admin/session');
  const data = await res.json();
  if (!data.authenticated) {
    location.href = '/admin/login.html?next=' + encodeURIComponent(location.pathname);
    return false;
  }
  return true;
}

function renderSessionBar(container) {
  container.innerHTML = `
    <div class="session-bar">
      <button class="btn-link" id="changePassBtn" type="button">Cambiar contraseña</button>
      <button class="btn-link" id="logoutBtn" type="button">Cerrar sesión</button>
    </div>
  `;
  container.querySelector('#logoutBtn').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    location.href = '/admin/login.html';
  });
  container.querySelector('#changePassBtn').addEventListener('click', openChangePasswordModal);
}

function openChangePasswordModal() {
  let backdrop = document.getElementById('pwModalBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.id = 'pwModalBackdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h2>Cambiar contraseña</h2>
        <label class="field"><span>Contraseña actual</span><input type="password" id="pwCurrent" autocomplete="current-password"></label>
        <label class="field"><span>Contraseña nueva (mínimo 6 caracteres)</span><input type="password" id="pwNew" autocomplete="new-password"></label>
        <p class="error" id="pwError"></p>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="pwCancelBtn" type="button">Cancelar</button>
          <button class="btn btn-primary" id="pwSaveBtn" type="button">Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.querySelector('#pwCancelBtn').addEventListener('click', () => backdrop.classList.add('hidden'));
    backdrop.querySelector('#pwSaveBtn').addEventListener('click', async () => {
      const currentPassword = backdrop.querySelector('#pwCurrent').value;
      const newPassword = backdrop.querySelector('#pwNew').value;
      const errorEl = backdrop.querySelector('#pwError');
      errorEl.textContent = '';
      try {
        const res = await fetch('/api/admin/change-password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo cambiar la contraseña');
        errorEl.style.color = 'var(--brand-dark)';
        errorEl.textContent = 'Contraseña actualizada.';
        setTimeout(() => backdrop.classList.add('hidden'), 1200);
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
  }
  backdrop.querySelector('#pwCurrent').value = '';
  backdrop.querySelector('#pwNew').value = '';
  backdrop.querySelector('#pwError').textContent = '';
  backdrop.classList.remove('hidden');
}
