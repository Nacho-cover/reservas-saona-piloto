// Pantalla de Usuarios (solo Administrador): alta, rol, locales asignados,
// desactivar y contraseña provisional. Usa /api/admin/users (server/usersApi.js).

const $ = (id) => document.getElementById(id);
const esc = (s) => escapeAuthHtml(s); // de authbar.js

const state = { users: [], roles: [], permissions: {}, restaurants: [], currentUserId: null, editing: null, selected: new Set() };

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401) { location.href = '/admin/login.html?next=' + encodeURIComponent(location.pathname); throw new Error('Sesión caducada'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Algo ha fallado');
  return data;
}

const roleById = (id) => state.roles.find(r => r.id === id) || { label: id };
const restName = (id) => (state.restaurants.find(r => r.id === id) || {}).name || `#${id}`;

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function localesText(u) {
  const role = roleById(u.role);
  if (role.allRestaurants) return { text: 'Todos los locales', none: false };
  if (!u.restaurantIds.length) return { text: 'Sin locales asignados', none: true };
  const names = u.restaurantIds.map(restName).sort((a, b) => a.localeCompare(b, 'es'));
  if (names.length <= 3) return { text: names.join(', '), none: false, title: names.join(', ') };
  return { text: `${names.slice(0, 2).join(', ')} y ${names.length - 2} más`, none: false, title: names.join(', ') };
}

// --- Lista -----------------------------------------------------------------------
function renderUsers() {
  const q = $('userSearch').value.trim().toLowerCase();
  const role = $('roleFilter').value;
  const showInactive = $('showInactive').checked;
  const list = state.users.filter(u => {
    if (!showInactive && !u.active) return false;
    if (role && u.role !== role) return false;
    if (!q) return true;
    const hay = [u.name, u.email, ...u.restaurantIds.map(restName)].join(' ').toLowerCase();
    return hay.includes(q);
  });
  const box = $('usersList');
  if (!list.length) {
    box.innerHTML = `<div class="users-empty">${state.users.length ? 'Ningún usuario coincide con el filtro.' : 'Todavía no hay usuarios.'}</div>`;
    return;
  }
  box.innerHTML = list.map(u => {
    const loc = localesText(u);
    const me = u.id === state.currentUserId;
    const meta = [
      u.lastLoginAt ? `Último acceso ${fmtDate(u.lastLoginAt)}` : 'Aún no ha entrado',
    ];
    return `
      <div class="user-row ${u.active ? '' : 'inactive'}">
        <div class="user-main">
          <div class="user-name">${esc(u.name || u.email)}${me ? ' <span class="user-meta">(tú)</span>' : ''}
            ${!u.active ? '<span class="tag-warn">Desactivado</span>' : u.mustChangePassword ? '<span class="tag-warn">Contraseña provisional</span>' : ''}</div>
          ${u.name ? `<div class="user-email">${esc(u.email)}</div>` : ''}
          <div class="user-meta">${esc(meta.join(' · '))}</div>
        </div>
        <span class="role-badge ${u.role === 'admin' ? 'admin' : ''}">${esc(roleById(u.role).label)}</span>
        <div class="user-locales ${loc.none ? 'none' : ''}" title="${esc(loc.title || '')}">${esc(loc.text)}</div>
        <div class="user-actions">
          <button type="button" data-act="edit" data-id="${u.id}">Editar</button>
          ${me ? '' : `<button type="button" data-act="reset" data-id="${u.id}">Nueva contraseña</button>`}
          ${me ? '' : u.active
            ? `<button type="button" class="danger" data-act="deactivate" data-id="${u.id}">Desactivar</button>`
            : `<button type="button" data-act="activate" data-id="${u.id}">Reactivar</button>`}
        </div>
      </div>`;
  }).join('');
}

function renderRolesMatrix() {
  const perms = Object.entries(state.permissions);
  $('rolesMatrix').innerHTML = `
    <thead><tr><th>Permiso</th>${state.roles.map(r => `<th>${esc(r.label)}</th>`).join('')}</tr></thead>
    <tbody>
      <tr><td>Locales</td>${state.roles.map(r => `<td>${r.allRestaurants ? 'Todos' : 'Asignados'}</td>`).join('')}</tr>
      ${perms.map(([id, label]) => `<tr><td>${esc(label)}</td>${state.roles.map(r =>
        r.permissions.includes(id) ? '<td class="yes">✓</td>' : '<td class="no">—</td>').join('')}</tr>`).join('')}
    </tbody>`;
}

async function load() {
  const data = await api('/api/admin/users');
  Object.assign(state, {
    users: data.users, roles: data.roles, permissions: data.permissions,
    restaurants: data.restaurants, currentUserId: data.currentUserId,
  });
  renderUsers();
}

// --- Alta / edición -------------------------------------------------------------
function renderLocales() {
  const q = $('uLocalesSearch').value.trim().toLowerCase();
  $('uLocales').innerHTML = state.restaurants
    .filter(r => !q || r.name.toLowerCase().includes(q))
    .map(r => `<label class="${state.selected.has(r.id) ? 'checked' : ''}">
      <input type="checkbox" value="${r.id}" ${state.selected.has(r.id) ? 'checked' : ''}> ${esc(r.name.replace(/^Saona /, ''))}</label>`)
    .join('') || '<div class="users-empty">Ningún local coincide.</div>';
  $('uLocalesCount').textContent = state.selected.size;
}

function updateRoleHint() {
  const role = roleById($('uRole').value);
  $('uRoleHint').textContent = role.description || '';
  $('uLocalesBox').classList.toggle('hidden', !!role.allRestaurants);
}

function openUserModal(user) {
  state.editing = user || null;
  state.selected = new Set(user ? user.restaurantIds : []);
  $('userModalTitle').textContent = user ? `Editar ${user.name || user.email}` : 'Nuevo usuario';
  $('uEmail').value = user ? user.email : '';
  $('uEmail').disabled = !!user;
  $('uName').value = user ? (user.name || '') : '';
  $('uRole').value = user ? user.role : 'encargado';
  // Para uno mismo no se cambia el rol ni se desactiva (el servidor tampoco lo deja).
  const isMe = user && user.id === state.currentUserId;
  $('uRole').disabled = !!isMe;
  $('uActiveRow').classList.toggle('hidden', !user || isMe);
  $('uActive').checked = user ? user.active : true;
  $('uLocalesSearch').value = '';
  $('userError').textContent = '';
  updateRoleHint();
  renderLocales();
  $('userModal').classList.remove('hidden');
  (user ? $('uName') : $('uEmail')).focus();
}

function closeUserModal() { $('userModal').classList.add('hidden'); }

async function saveUser() {
  const err = $('userError');
  err.textContent = '';
  const role = $('uRole').value;
  const body = {
    name: $('uName').value.trim(),
    role,
    restaurantIds: roleById(role).allRestaurants ? [] : [...state.selected],
  };
  const btn = $('userSaveBtn');
  btn.disabled = true;
  try {
    if (state.editing) {
      if (!$('uActiveRow').classList.contains('hidden')) body.active = $('uActive').checked;
      await api(`/api/admin/users/${state.editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      closeUserModal();
    } else {
      body.email = $('uEmail').value.trim();
      const data = await api('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
      closeUserModal();
      showTempPassword(data.user, data.tempPassword, true);
    }
    await load();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function showTempPassword(user, pwd, isNew) {
  $('pwdText').innerHTML = isNew
    ? `Usuario creado: <strong>${esc(user.email)}</strong>. Pásale esta contraseña provisional por un canal privado:`
    : `Nueva contraseña provisional para <strong>${esc(user.email)}</strong>. Sus sesiones abiertas se han cerrado.`;
  $('pwdValue').value = pwd;
  $('pwdModal').classList.remove('hidden');
}

async function onListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const user = state.users.find(u => u.id === Number(btn.dataset.id));
  if (!user) return;
  try {
    if (btn.dataset.act === 'edit') return openUserModal(user);
    if (btn.dataset.act === 'reset') {
      if (!confirm(`¿Generar una contraseña provisional nueva para ${user.email}? La actual dejará de funcionar.`)) return;
      const data = await api(`/api/admin/users/${user.id}/reset-password`, { method: 'POST' });
      showTempPassword(user, data.tempPassword, false);
      await load();
    }
    if (btn.dataset.act === 'deactivate') {
      if (!confirm(`¿Desactivar a ${user.name || user.email}? No podrá entrar al panel (se puede reactivar).`)) return;
      await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ active: false }) });
      await load();
    }
    if (btn.dataset.act === 'activate') {
      await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });
      await load();
    }
  } catch (err) {
    alert(err.message);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  if (!(await guardAdminPage('users'))) return;
  renderSessionBar($('sessionBar'));

  try { await load(); } catch (err) { $('usersList').innerHTML = `<div class="users-empty">${esc(err.message)}</div>`; return; }
  renderRolesMatrix();
  const roleOptions = state.roles.map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join('');
  $('roleFilter').innerHTML = '<option value="">Todos los roles</option>' + roleOptions;
  $('uRole').innerHTML = roleOptions;

  $('userSearch').addEventListener('input', renderUsers);
  $('roleFilter').addEventListener('change', renderUsers);
  $('showInactive').addEventListener('change', renderUsers);
  $('usersList').addEventListener('click', onListClick);
  $('newUserBtn').addEventListener('click', () => openUserModal(null));
  $('userCancelBtn').addEventListener('click', closeUserModal);
  $('userSaveBtn').addEventListener('click', saveUser);
  $('uRole').addEventListener('change', updateRoleHint);
  $('uLocalesSearch').addEventListener('input', renderLocales);
  $('uLocales').addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    const id = Number(e.target.value);
    if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
    e.target.closest('label').classList.toggle('checked', e.target.checked);
    $('uLocalesCount').textContent = state.selected.size;
  });
  $('uSelectVisible').addEventListener('click', () => {
    $('uLocales').querySelectorAll('input[type=checkbox]').forEach(cb => state.selected.add(Number(cb.value)));
    renderLocales();
  });
  $('uClearAll').addEventListener('click', () => { state.selected.clear(); renderLocales(); });
  $('pwdCopy').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText($('pwdValue').value); } catch { $('pwdValue').select(); document.execCommand('copy'); }
    e.target.textContent = 'Copiada';
    setTimeout(() => { e.target.textContent = 'Copiar'; }, 1500);
  });
  $('pwdClose').addEventListener('click', () => $('pwdModal').classList.add('hidden'));
});
