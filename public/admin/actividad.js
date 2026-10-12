// Pantalla de Actividad: el registro de cambios del panel (server/audit.js).
// Administrador: todo. El resto de roles con informes: lo de sus locales.

const $ = (id) => document.getElementById(id);
const esc = (s) => escapeAuthHtml(s); // de authbar.js
let entries = [];

const iso = (d) => d.toISOString().slice(0, 10);

async function load() {
  const p = new URLSearchParams({
    restaurantId: $('fLocal').value, userId: $('fUser').value, area: $('fArea').value,
    from: $('fFrom').value, to: $('fTo').value, q: $('fQ').value.trim(), limit: 500,
  });
  for (const [k, v] of [...p]) if (!v) p.delete(k);
  const res = await fetch('/api/admin/activity?' + p);
  if (res.status === 401) { location.href = '/admin/login.html?next=' + encodeURIComponent(location.pathname); return; }
  const data = await res.json();
  if (!res.ok) { $('actList').innerHTML = `<div class="act-empty">${esc(data.error || 'No se pudo cargar')}</div>`; return; }
  entries = data.entries;
  // Lista de personas: se rellena una vez, conservando la elegida.
  const sel = $('fUser');
  if (sel.options.length <= 1) {
    sel.innerHTML = '<option value="">Todas</option>' + data.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  }
  $('actCount').textContent = entries.length >= data.limit
    ? `Mostrando los ${data.limit} cambios más recientes (afina los filtros para ver más atrás).`
    : `${entries.length} cambio${entries.length === 1 ? '' : 's'}`;
  render();
}

function dayLabel(d) {
  const today = iso(new Date());
  const yest = iso(new Date(Date.now() - 864e5));
  if (d === today) return 'Hoy';
  if (d === yest) return 'Ayer';
  return new Date(d + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

function render() {
  if (!entries.length) { $('actList').innerHTML = '<div class="act-empty">No hay cambios con estos filtros.</div>'; return; }
  let html = '';
  let lastDay = '';
  for (const e of entries) {
    const day = e.at.slice(0, 10);
    if (day !== lastDay) { html += `<div class="act-day">${esc(dayLabel(day))}</div>`; lastDay = day; }
    html += `<div class="act-row" data-id="${e.id}">
      <span class="act-time">${esc(e.at.slice(11, 16))}</span>
      <div class="act-what">${esc(e.summary || e.action)}<div class="act-who">${esc(e.user_name || 'Sistema')}</div></div>
      ${e.restaurant_name ? `<span class="act-local">${esc(e.restaurant_name.replace(/^Saona /, ''))}</span>` : '<span></span>'}
    </div>`;
  }
  $('actList').innerHTML = html;
}

function toggleDetail(e) {
  const row = e.target.closest('.act-row');
  if (!row) return;
  const open = row.querySelector('.act-detail');
  if (open) { open.remove(); return; }
  const entry = entries.find(x => String(x.id) === row.dataset.id);
  if (!entry) return;
  const pre = document.createElement('div');
  pre.className = 'act-detail';
  pre.textContent = `${entry.at} · ${entry.user_email || ''} · ${entry.action}\n\n` + JSON.stringify(entry.details || {}, null, 2);
  row.appendChild(pre);
}

function exportExcel() {
  if (!window.XLSX) return alert('No se pudo cargar el generador de Excel. Recarga la página.');
  const ws = XLSX.utils.aoa_to_sheet([['Fecha y hora', 'Persona', 'Correo', 'Local', 'Cambio', 'Tipo'],
    ...entries.map(e => [e.at, e.user_name || '', e.user_email || '', e.restaurant_name || '', e.summary || '', e.action])]);
  ws['!cols'] = [{ wch: 19 }, { wch: 22 }, { wch: 30 }, { wch: 24 }, { wch: 80 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Actividad');
  XLSX.writeFile(wb, `actividad-${iso(new Date())}.xlsx`);
}

window.addEventListener('DOMContentLoaded', async () => {
  if (!(await guardAdminPage('reports'))) return;
  renderSessionBar($('sessionBar'));

  const rs = CURRENT_USER.restaurants;
  const current = getRestaurantId();
  $('fLocal').innerHTML = (rs.length > 1 ? `<option value="all">${CURRENT_USER.allRestaurants ? 'Todos los locales' : 'Todos mis locales'}</option>` : '') +
    rs.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  // Administrador: por defecto todo el grupo; el resto, su local actual.
  $('fLocal').value = CURRENT_USER.allRestaurants ? 'all' : String(current);
  $('fFrom').value = iso(new Date(Date.now() - 6 * 864e5));
  $('fTo').value = iso(new Date());

  ['fLocal', 'fUser', 'fArea', 'fFrom', 'fTo'].forEach(id => $(id).addEventListener('change', load));
  let t;
  $('fQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 350); });
  $('actList').addEventListener('click', toggleDetail);
  $('actExport').addEventListener('click', exportExcel);
  await load();
});
