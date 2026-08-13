const RESTAURANT_ID = 1;
const $ = (id) => document.getElementById(id);

const state = { date: todayISO(), reservations: [], tables: [], shift: 'Comida' };

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function shiftLabel(time) {
  const [h] = time.split(':').map(Number);
  return h < 18 ? 'Comida' : 'Cena';
}

const STATUS_LABELS = {
  confirmed: 'Confirmada',
  seated: 'Sentados',
  completed: 'Completada',
  cancelled: 'Cancelada',
  no_show: 'No-show',
};

async function loadRestaurant() {
  const res = await fetch(`/api/restaurants/${RESTAURANT_ID}`);
  const data = await res.json();
  $('restaurantName').textContent = data.name;
}

async function loadReservations() {
  const [resRes, tablesRes] = await Promise.all([
    fetch(`/api/reservations?restaurantId=${RESTAURANT_ID}&date=${state.date}`),
    fetch(`/api/tables?restaurantId=${RESTAURANT_ID}&date=${state.date}`),
  ]);
  state.reservations = await resRes.json();
  state.tables = await tablesRes.json();
  render();
}

function renderFloorPlanView() {
  const busyTableNames = new Set(
    state.reservations
      .filter(r => r.status !== 'cancelled' && shiftLabel(r.time) === state.shift)
      .flatMap(r => r.tables || [])
  );
  renderFloorPlan($('floorPlanView'), state.tables, {
    getClass: (t) => (busyTableNames.has(t.name) ? 'status-busy' : ''),
  });
}

function render() {
  const active = state.reservations.filter(r => r.status !== 'cancelled');
  const totalGuests = active.reduce((sum, r) => sum + r.party_size, 0);
  $('dayStats').innerHTML = `<strong>${active.length}</strong> reservas · <strong>${totalGuests}</strong> comensales`;

  const groups = { Comida: [], Cena: [] };
  for (const r of state.reservations) {
    const key = shiftLabel(r.time);
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  renderFloorPlanView();

  const container = $('shiftColumns');
  container.innerHTML = '';
  for (const [shiftName, rows] of Object.entries(groups)) {
    const col = document.createElement('div');
    col.className = 'shift-col';
    const h3 = document.createElement('h3');
    h3.textContent = shiftName;
    col.appendChild(h3);

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Sin reservas';
      col.appendChild(empty);
    } else {
      rows.sort((a, b) => a.time.localeCompare(b.time));
      for (const r of rows) col.appendChild(renderRow(r));
    }
    container.appendChild(col);
  }
}

function renderRow(r) {
  const row = document.createElement('div');
  row.className = 'res-row';

  const time = document.createElement('div');
  time.className = 'res-time';
  time.textContent = r.time;

  const info = document.createElement('div');
  info.className = 'res-info';
  info.innerHTML = `
    <div class="res-name">${escapeHtml(r.customer_name)} · ${r.party_size}p ${r.tables && r.tables.length ? `· Mesa ${r.tables.join(', ')}` : ''}</div>
    <div class="res-meta">${r.phone || ''} ${r.notes ? '· ' + escapeHtml(r.notes) : ''}</div>
  `;

  const badge = document.createElement('span');
  badge.className = 'res-badge' + (r.source === 'phone' || r.source === 'admin' ? ' phone' : '') + (r.status === 'cancelled' ? ' cancelled' : '');
  badge.textContent = r.status === 'confirmed' ? (r.source === 'phone' || r.source === 'admin' ? 'Tel.' : 'Web') : STATUS_LABELS[r.status];

  const actions = document.createElement('div');
  actions.className = 'res-actions';
  if (r.status !== 'cancelled' && r.status !== 'completed' && r.status !== 'no_show') {
    if (r.status === 'confirmed') {
      actions.appendChild(actionBtn('Sentar', () => updateStatus(r.id, 'seated')));
    }
    if (r.status === 'seated') {
      actions.appendChild(actionBtn('Completar', () => updateStatus(r.id, 'completed')));
    }
    actions.appendChild(actionBtn('Cancelar', () => cancelReservation(r.id)));
  }

  row.appendChild(time);
  row.appendChild(info);
  row.appendChild(badge);
  row.appendChild(actions);
  return row;
}

function actionBtn(label, onClick) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function updateStatus(id, status) {
  await fetch(`/api/reservations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  loadReservations();
}

async function cancelReservation(id) {
  if (!confirm('¿Cancelar esta reserva?')) return;
  await fetch(`/api/reservations/${id}`, { method: 'DELETE' });
  loadReservations();
}

// --- Modal: new reservation (phone) -----------------------------------
function openModal() {
  $('modalTitle').textContent = 'Nueva reserva (teléfono)';
  $('mName').value = '';
  $('mPhone').value = '';
  $('mDate').value = state.date;
  $('mTime').value = '';
  $('mParty').value = 2;
  $('mNotes').value = '';
  $('modalError').textContent = '';
  $('modalBackdrop').classList.remove('hidden');
}
function closeModal() {
  $('modalBackdrop').classList.add('hidden');
}

async function saveModal() {
  const customerName = $('mName').value.trim();
  const phone = $('mPhone').value.trim();
  const date = $('mDate').value;
  const time = $('mTime').value;
  const partySize = Number($('mParty').value);
  const notes = $('mNotes').value.trim();

  if (!customerName || !date || !time || !partySize) {
    $('modalError').textContent = 'Completa nombre, fecha, hora y comensales.';
    return;
  }

  const btn = $('modalSaveBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: RESTAURANT_ID, customerName, phone, partySize, date, time, notes, source: 'phone',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo crear la reserva');
    closeModal();
    if (date === state.date) loadReservations();
  } catch (err) {
    $('modalError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function shiftDate(days) {
  const d = new Date(state.date + 'T00:00:00');
  d.setDate(d.getDate() + days);
  state.date = d.toISOString().slice(0, 10);
  $('dateFilter').value = state.date;
  loadReservations();
}

window.addEventListener('DOMContentLoaded', async () => {
  if (!(await guardAdminPage())) return;
  renderSessionBar($('sessionBar'));

  $('dateFilter').value = state.date;
  await loadRestaurant();
  await loadReservations();

  $('dateFilter').addEventListener('change', (e) => { state.date = e.target.value; loadReservations(); });
  $('prevDayBtn').addEventListener('click', () => shiftDate(-1));
  $('nextDayBtn').addEventListener('click', () => shiftDate(1));
  $('todayBtn').addEventListener('click', () => { state.date = todayISO(); $('dateFilter').value = state.date; loadReservations(); });

  $('fpShiftToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-shift]');
    if (!btn) return;
    state.shift = btn.dataset.shift;
    $('fpShiftToggle').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    renderFloorPlanView();
  });

  $('openNewBtn').addEventListener('click', openModal);
  $('modalCancelBtn').addEventListener('click', closeModal);
  $('modalSaveBtn').addEventListener('click', saveModal);

  // auto-refresh every 30s to reflect reservations coming from web
  setInterval(loadReservations, 30000);
});
