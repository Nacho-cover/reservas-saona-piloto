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
          ${me || !u.active ? '' : `<button type="button" data-act="invite" data-id="${u.id}" title="Manda un email con un enlace para elegir contraseña">Enviar enlace</button>`}
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
  $('uInviteRow').classList.toggle('hidden', !!user);
  $('uInvite').checked = true;
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
      body.sendInvite = $('uInvite').checked;
      const data = await api('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
      closeUserModal();
      showTempPassword(data.user, data.tempPassword, true, data.emailSent);
    }
    await load();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function showTempPassword(user, pwd, isNew, emailSent) {
  const emailLine = emailSent === true
    ? ' Le hemos enviado un email con un enlace para elegir su contraseña; esta provisional es por si no le llega.'
    : emailSent === false
      ? ' <span style="color:var(--danger)">El email de invitación no se pudo enviar</span>: pásale esta contraseña provisional por un canal privado.'
      : ' Pásale esta contraseña provisional por un canal privado:';
  $('pwdText').innerHTML = isNew
    ? `Usuario creado: <strong>${esc(user.email)}</strong>.${emailLine}`
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
    if (btn.dataset.act === 'invite') {
      if (!confirm(`¿Enviar a ${user.email} un email con un enlace para elegir contraseña? Sus enlaces anteriores dejarán de valer.`)) return;
      btn.disabled = true;
      await api(`/api/admin/users/${user.id}/invite`, { method: 'POST' });
      btn.textContent = 'Enviado ✓';
      setTimeout(() => { btn.textContent = 'Enviar enlace'; btn.disabled = false; }, 2500);
      return;
    }
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

// --- Importar desde Excel ------------------------------------------------------
// Se lee el fichero en el navegador (SheetJS), se valida fila a fila contra los roles y
// locales reales, se enseña una vista previa y solo entonces se manda al servidor, que
// vuelve a validarlo todo antes de crear nada.
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
const stripSaona = (s) => s.replace(/^saona /, '');
let importRows = [];

function matchRole(v) {
  const n = norm(v);
  if (!n) return null;
  const r = state.roles.find(r => norm(r.id) === n || norm(r.label) === n || norm(r.label).startsWith(n));
  return r ? r.id : null;
}

function matchLocales(v) {
  const parts = String(v ?? '').split(/[;\n|]+|,(?=\s*[^\d\s])/).map(x => x.trim()).filter(Boolean);
  const ids = [];
  const unknown = [];
  for (const part of parts) {
    const n = norm(part);
    if (n === 'todos' || n === 'todos los locales') { state.restaurants.forEach(r => ids.push(r.id)); continue; }
    if (/^\d+$/.test(n) && state.restaurants.some(r => r.id === Number(n))) { ids.push(Number(n)); continue; }
    const exact = state.restaurants.filter(r => norm(r.name) === n || stripSaona(norm(r.name)) === stripSaona(n));
    const partial = exact.length ? exact : state.restaurants.filter(r => stripSaona(norm(r.name)).includes(stripSaona(n)));
    if (partial.length === 1) ids.push(partial[0].id);
    else unknown.push(partial.length > 1 ? `${part} (ambiguo: ${partial.length} locales)` : part);
  }
  return { ids: [...new Set(ids)], unknown };
}

function pick(row, names) {
  for (const key of Object.keys(row)) if (names.includes(norm(key))) return row[key];
  return '';
}

function validateImport(raw) {
  const existing = new Set(state.users.map(u => u.email));
  const seen = new Set();
  return raw.map((row, i) => {
    const email = String(pick(row, ['correo', 'email', 'e-mail', 'mail', 'usuario'])).trim().toLowerCase();
    const name = String(pick(row, ['nombre', 'name', 'nombre y apellidos'])).trim();
    const roleRaw = pick(row, ['rol', 'role', 'perfil']);
    const localesRaw = pick(row, ['locales', 'local', 'restaurantes', 'restaurante']);
    const role = matchRole(roleRaw);
    const loc = matchLocales(localesRaw);
    const r = { row: i + 2, email, name, roleRaw, role, localesRaw, restaurantIds: loc.ids, status: 'ok', note: '' };
    const allRest = role && roleById(role).allRestaurants;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { r.status = 'err'; r.note = 'Correo no válido'; }
    else if (seen.has(email)) { r.status = 'err'; r.note = 'Correo repetido en el fichero'; }
    else if (existing.has(email)) { r.status = 'skip'; r.note = 'Ya existe: se salta'; }
    else if (!role) { r.status = 'err'; r.note = `Rol no reconocido${roleRaw ? ` («${roleRaw}»)` : ''}`; }
    else if (!allRest && loc.unknown.length) { r.status = 'err'; r.note = `Local no encontrado: ${loc.unknown.join(', ')}`; }
    else if (!allRest && !loc.ids.length) { r.status = 'err'; r.note = 'Sin locales'; }
    seen.add(email);
    if (allRest) r.restaurantIds = [];
    return r;
  });
}

function renderImportPreview() {
  const ok = importRows.filter(r => r.status === 'ok').length;
  const err = importRows.filter(r => r.status === 'err').length;
  const skip = importRows.filter(r => r.status === 'skip').length;
  const locText = (r) => r.role && roleById(r.role).allRestaurants ? 'Todos'
    : r.restaurantIds.length > 3 ? `${r.restaurantIds.length} locales` : r.restaurantIds.map(restName).join(', ');
  $('importPreview').innerHTML = `
    <p class="import-summary"><strong>${importRows.length}</strong> filas: <strong>${ok}</strong> para crear${skip ? `, ${skip} ya existen` : ''}${err ? `, <span class="bad">${err} con errores</span>` : ''}.
      ${err ? 'Corrige el fichero y vuelve a elegirlo.' : ''}</p>
    <div class="import-table-wrap"><table class="import-table">
      <thead><tr><th>Fila</th><th>Correo</th><th>Nombre</th><th>Rol</th><th>Locales</th><th>Estado</th></tr></thead>
      <tbody>${importRows.map(r => `<tr class="${r.status}">
        <td>${r.row}</td><td>${esc(r.email)}</td><td>${esc(r.name)}</td>
        <td>${esc(r.role ? roleById(r.role).label : r.roleRaw)}</td>
        <td title="${esc(r.restaurantIds.map(restName).join(', '))}">${esc(locText(r) || r.localesRaw)}</td>
        <td class="${r.status === 'err' ? 'st-err' : r.status === 'ok' ? 'st-ok' : ''}">${r.status === 'ok' ? 'Se crea' : esc(r.note)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  $('importInviteRow').classList.toggle('hidden', !ok || !!err);
  $('importGo').classList.toggle('hidden', !ok || !!err);
  $('importGo').textContent = `Crear ${ok} usuario${ok === 1 ? '' : 's'}`;
}

async function onImportFile(e) {
  const file = e.target.files[0];
  $('importError').textContent = '';
  if (!file) return;
  $('importFileName').textContent = file.name;
  try {
    if (!window.XLSX) throw new Error('No se pudo cargar el lector de Excel. Recarga la página.');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' })
      .filter(row => Object.values(row).some(v => String(v).trim() !== ''));
    if (!raw.length) throw new Error('La primera hoja del fichero está vacía.');
    importRows = validateImport(raw);
    renderImportPreview();
  } catch (err) {
    importRows = [];
    $('importPreview').innerHTML = '';
    $('importGo').classList.add('hidden');
    $('importError').textContent = err.message;
  } finally {
    e.target.value = '';
  }
}

function downloadTemplate() {
  const wb = XLSX.utils.book_new();
  const users = XLSX.utils.aoa_to_sheet([
    ['Correo', 'Nombre', 'Rol', 'Locales'],
    ['nombre.apellido@ejemplo.com', 'Nombre Apellido', 'Encargado', state.restaurants[0] ? state.restaurants[0].name : ''],
  ]);
  users['!cols'] = [{ wch: 34 }, { wch: 24 }, { wch: 16 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, users, 'Usuarios');
  const roles = XLSX.utils.aoa_to_sheet([['Rol', 'Qué puede hacer'], ...state.roles.map(r => [r.label, r.description])]);
  roles['!cols'] = [{ wch: 16 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, roles, 'Roles');
  const locs = XLSX.utils.aoa_to_sheet([['Local (escríbelo así en la columna Locales, varios separados por «;» o «Todos»)'], ...state.restaurants.map(r => [r.name])]);
  locs['!cols'] = [{ wch: 70 }];
  XLSX.utils.book_append_sheet(wb, locs, 'Locales');
  XLSX.writeFile(wb, 'plantilla-usuarios-saona.xlsx');
}

async function runImport() {
  const rows = importRows.filter(r => r.status === 'ok');
  if (!rows.length) return;
  const btn = $('importGo');
  btn.disabled = true;
  $('importError').textContent = '';
  try {
    const data = await api('/api/admin/users/bulk', {
      method: 'POST',
      body: JSON.stringify({
        sendInvites: $('importInvite').checked,
        users: rows.map(r => ({ email: r.email, name: r.name, role: r.role, restaurantIds: r.restaurantIds })),
      }),
    });
    showImportResult(data);
    await load();
  } catch (err) {
    $('importError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function showImportResult(data) {
  const created = data.created || [];
  const invited = created.filter(u => u.emailSent === true).length;
  const failed = created.filter(u => u.emailSent === false).length;
  $('importStep1').classList.add('hidden');
  $('importGo').classList.add('hidden');
  const step2 = $('importStep2');
  step2.classList.remove('hidden');
  step2.innerHTML = `
    <p class="import-summary"><strong>${created.length}</strong> usuarios creados${data.skipped && data.skipped.length ? `, ${data.skipped.length} ya existían` : ''}.
      ${invited ? `${invited} invitaciones enviadas por email.` : ''} ${failed ? `<span class="bad">${failed} emails no se pudieron enviar.</span>` : ''}</p>
    <p class="cfg-hint">Las contraseñas provisionales solo se ven ahora. Descárgalas si las vas a repartir tú y borra el fichero cuando termines.</p>
    <button class="btn btn-secondary" type="button" id="importDownload">Descargar contraseñas provisionales (Excel)</button>
    <div class="import-table-wrap" style="margin-top:12px"><table class="import-table">
      <thead><tr><th>Correo</th><th>Rol</th><th>Contraseña provisional</th><th>Email</th></tr></thead>
      <tbody>${created.map(u => `<tr><td>${esc(u.email)}</td><td>${esc(roleById(u.role).label)}</td>
        <td><code>${esc(u.tempPassword)}</code></td><td>${u.emailSent === true ? 'Enviado' : u.emailSent === false ? '<span class="st-err">No enviado</span>' : '—'}</td></tr>`).join('')}</tbody>
    </table></div>`;
  $('importDownload').addEventListener('click', () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Correo', 'Nombre', 'Rol', 'Contraseña provisional', 'Acceso'],
      ...created.map(u => [u.email, u.name || '', roleById(u.role).label, u.tempPassword, `${location.origin}/admin/login.html`])]);
    ws['!cols'] = [{ wch: 34 }, { wch: 24 }, { wch: 16 }, { wch: 22 }, { wch: 48 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Accesos');
    XLSX.writeFile(wb, 'accesos-provisionales.xlsx');
  });
}

function openImport() {
  importRows = [];
  $('importStep1').classList.remove('hidden');
  $('importStep2').classList.add('hidden');
  $('importPreview').innerHTML = '';
  $('importFileName').textContent = '';
  $('importError').textContent = '';
  $('importGo').classList.add('hidden');
  $('importInviteRow').classList.add('hidden');
  $('importModal').classList.remove('hidden');
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
  $('importBtn').addEventListener('click', openImport);
  $('importCancel').addEventListener('click', () => $('importModal').classList.add('hidden'));
  $('importFile').addEventListener('change', onImportFile);
  $('templateBtn').addEventListener('click', downloadTemplate);
  $('importGo').addEventListener('click', runImport);
});
