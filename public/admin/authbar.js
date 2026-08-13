// Compartido por admin/index.html y admin/config.html: comprueba la sesión antes de
// dejar ver nada del panel, y pinta el botón de cerrar sesión / cambiar contraseña.
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
