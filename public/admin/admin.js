const RESTAURANT_ID = 1;
const $ = (id) => document.getElementById(id);

const state = { date: todayISO(), reservations: [], tables: [], closures: [], shift: 'Comida', monthCursor: todayISO().slice(0, 7) };

// OJO: nunca usar Date.toISOString() aquí — convierte a UTC, y con la zona horaria
// de España (UTC+1/+2) eso desplaza la fecha un día hacia atrás. Hay que formatear
// con los componentes de fecha LOCALES.
function toLocalISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayISO() {
  return toLocalISO(new Date());
}

function shiftLabel(time) {
  const [h] = time.split(':').map(Number);
  return h < 18 ? 'Comida' : 'Cena';
}

// Progreso del servicio en mesa, con su color (igual que en Cover): cada estado
// tiene el siguiente paso y, opcionalmente, la etiqueta del botón para avanzar.
const STATUS_FLOW = {
  confirmed: { label: 'Confirmada', color: 'status-confirmed', next: 'seated', nextLabel: 'Sentar' },
  seated: { label: 'Sentada', color: 'status-seated', next: 'eating', nextLabel: 'Empezar a comer' },
  eating: { label: 'Comiendo', color: 'status-eating', next: 'dessert', nextLabel: 'Postre' },
  dessert: { label: 'Postre', color: 'status-dessert', next: 'paid', nextLabel: 'Pagar' },
  paid: { label: 'Pagada', color: 'status-paid', next: 'completed', nextLabel: 'Completar' },
  completed: { label: 'Completada', color: '', next: null },
  cancelled: { label: 'Cancelada', color: '', next: null },
  no_show: { label: 'No-show', color: '', next: null },
};
const STATUS_LABELS = Object.fromEntries(Object.entries(STATUS_FLOW).map(([k, v]) => [k, v.label]));

async function loadRestaurant() {
  const res = await fetch(`/api/restaurants/${RESTAURANT_ID}`);
  const data = await res.json();
  $('restaurantName').textContent = data.name;
}

async function loadReservations() {
  const [resRes, tablesRes, closuresRes] = await Promise.all([
    fetch(`/api/reservations?restaurantId=${RESTAURANT_ID}&date=${state.date}`),
    fetch(`/api/tables?restaurantId=${RESTAURANT_ID}&date=${state.date}`),
    fetch(`/api/closures?restaurantId=${RESTAURANT_ID}&date=${state.date}`),
  ]);
  state.reservations = await resRes.json();
  state.tables = await tablesRes.json();
  state.closures = await closuresRes.json();
  render();
}

// --- Cerrar/abrir un turno concreto (deja de aceptar reservas online nuevas ese
// turno; las ya hechas no se tocan) ----------------------------------------
function renderClosureBar() {
  const dayClosed = state.closures.find(c => c.shift === null);
  const shiftClosure = state.closures.find(c => c.shift === state.shift);
  const bar = $('closureBar');

  if (dayClosed) {
    bar.innerHTML = `<div class="closure-bar closed">🔒 Todo el día ${state.date} está cerrado a reservas nuevas.
      <button class="btn-reopen-shift" id="reopenDayBtn">Reabrir el día</button></div>`;
    $('reopenDayBtn').addEventListener('click', () => removeClosure(dayClosed.id));
    return;
  }

  if (shiftClosure) {
    bar.innerHTML = `<div class="closure-bar closed">🔒 Turno de ${state.shift} cerrado a reservas nuevas.
      <button class="btn-reopen-shift" id="reopenShiftBtn">Reabrir ${state.shift}</button></div>`;
    $('reopenShiftBtn').addEventListener('click', () => removeClosure(shiftClosure.id));
  } else {
    bar.innerHTML = `<div class="closure-bar">Turno de ${state.shift} abierto a reservas.
      <button class="btn-close-shift" id="closeShiftBtn">Cerrar ${state.shift}</button></div>`;
    $('closeShiftBtn').addEventListener('click', () => addClosure(state.shift));
  }
}

async function addClosure(shift) {
  await fetch('/api/closures', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: RESTAURANT_ID, date: state.date, shift }),
  });
  await loadReservations();
}

async function removeClosure(id) {
  await fetch(`/api/closures/${id}`, { method: 'DELETE' });
  await loadReservations();
}

function renderFloorPlanView() {
  renderClosureBar();
  const shiftReservations = state.reservations.filter(r => r.status !== 'cancelled' && r.status !== 'no_show' && shiftLabel(r.time) === state.shift);
  const tableStatus = new Map();
  shiftReservations.forEach(r => (r.tables || []).forEach(name => tableStatus.set(name, r.status)));
  const busyTableNames = new Set(tableStatus.keys());

  renderFloorPlan($('floorPlanView'), state.tables, {
    getClass: (t) => {
      const status = tableStatus.get(t.name);
      if (!status) return '';
      return (STATUS_FLOW[status] && STATUS_FLOW[status].color) || 'status-busy';
    },
    features: SALA_INTERIOR_FEATURES,
    zoneLabels: SALA_INTERIOR_ZONE_LABELS,
  });

  // Aforo máximo = suma del máximo de comensales de cada mesa activa del plano del día
  // (no el cupo de aforo por franja, que es más restrictivo y varía por hora).
  const maxCovers = state.tables.reduce((sum, t) => sum + t.capacity_max, 0);
  const coversReserved = shiftReservations.reduce((sum, r) => sum + r.party_size, 0);
  const totalTables = state.tables.length;
  const occupiedTables = busyTableNames.size;

  const pctClass = (used, total) => {
    if (!total) return '';
    const pct = used / total;
    if (pct >= 1) return 'fp-stat-full';
    if (pct >= 0.8) return 'fp-stat-warn';
    return '';
  };

  $('fpStats').innerHTML = `
    <span class="fp-stat ${pctClass(coversReserved, maxCovers)}"><span class="fp-stat-icon">👥</span><b>${coversReserved}</b> / ${maxCovers} comensales</span>
    <span class="fp-stat ${pctClass(occupiedTables, totalTables)}"><span class="fp-stat-icon">🍽️</span><b>${occupiedTables}</b> / ${totalTables} mesas</span>
  `;

  const zoneOrder = [];
  const zoneTotals = {};
  state.tables.forEach(t => {
    const zone = t.zoneName || 'Sin zona';
    if (!zoneTotals[zone]) { zoneTotals[zone] = { total: 0, busy: 0 }; zoneOrder.push(zone); }
    zoneTotals[zone].total++;
    if (busyTableNames.has(t.name)) zoneTotals[zone].busy++;
  });
  $('fpZoneStats').innerHTML = zoneOrder
    .map(zone => `<div class="fp-zone-stat">${zone} <b>${zoneTotals[zone].busy}/${zoneTotals[zone].total}</b></div>`)
    .join('');
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

  const flow = STATUS_FLOW[r.status] || {};
  let badgeExtraClass = '';
  if (r.status === 'cancelled') badgeExtraClass = r.cancelled_by === 'customer' ? 'cancelled-customer' : 'cancelled';
  else if (r.status === 'no_show') badgeExtraClass = 'no-show';

  const badge = document.createElement('span');
  badge.className = 'res-badge' + (flow.color ? ' ' + flow.color : '') + (badgeExtraClass ? ' ' + badgeExtraClass : '');
  badge.title = STATUS_LABELS[r.status] || r.status;
  let statusText = STATUS_LABELS[r.status] || r.status;
  if (r.status === 'cancelled' && r.cancelled_by) {
    statusText += r.cancelled_by === 'restaurant' ? ' (restaurante)' : ' (cliente)';
  }
  badge.textContent = r.status === 'confirmed' ? (r.source === 'phone' || r.source === 'admin' ? 'Tel.' : 'Web') : statusText;

  const actions = document.createElement('div');
  actions.className = 'res-actions';
  if (r.status !== 'cancelled' && r.status !== 'completed' && r.status !== 'no_show') {
    if (flow.next) {
      actions.appendChild(actionBtn(flow.nextLabel, () => updateStatus(r.id, flow.next)));
    }
    actions.appendChild(actionBtn('Cambiar mesa', () => openMoveModal(r), 'btn-move'));
    actions.appendChild(actionBtn('No-show', () => markNoShow(r.id), 'btn-noshow'));
    actions.appendChild(actionBtn('Cancela restaurante', () => cancelReservation(r.id, 'restaurant'), 'btn-cancel-restaurant'));
    actions.appendChild(actionBtn('Cancela cliente', () => cancelReservation(r.id, 'customer'), 'btn-cancel-customer'));
  }

  row.appendChild(time);
  row.appendChild(info);
  row.appendChild(badge);
  row.appendChild(actions);
  return row;
}

function actionBtn(label, onClick, extraClass) {
  const btn = document.createElement('button');
  btn.textContent = label;
  if (extraClass) btn.className = extraClass;
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

async function cancelReservation(id, cancelledBy) {
  const who = cancelledBy === 'restaurant' ? 'el restaurante' : 'el cliente';
  if (!confirm(`¿Cancelar esta reserva? (cancela ${who})`)) return;
  await fetch(`/api/reservations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled', cancelledBy }),
  });
  loadReservations();
}

async function markNoShow(id) {
  if (!confirm('¿Marcar como no-show? (el cliente reservó y no se presentó)')) return;
  await updateStatus(id, 'no_show');
}

// --- Modal: cambiar de mesa una reserva ya existente --------------------
let moveReservationId = null;

async function openMoveModal(r) {
  moveReservationId = r.id;
  const currentTables = (r.tables && r.tables.length) ? r.tables.join(', ') : '—';
  $('moveModalInfo').textContent = `${r.customer_name} · ${r.party_size}p · ${r.date} ${r.time} · mesa actual: ${currentTables}`;
  $('moveModalError').textContent = '';
  const sel = $('moveTableSelect');
  sel.innerHTML = '<option value="">Cargando…</option>';
  $('moveModalBackdrop').classList.remove('hidden');

  const params = new URLSearchParams({
    restaurantId: RESTAURANT_ID, date: r.date, time: r.time, partySize: r.party_size,
    excludeReservationId: r.id, durationMinutes: r.duration_minutes,
  });
  const res = await fetch(`/api/table-map?${params}`);
  const map = await res.json();

  const options = [];
  (map.tables || []).forEach(t => {
    if (t.status === 'available') {
      options.push({ value: JSON.stringify([t.id]), label: `${t.name} (${t.capacityMin}-${t.capacityMax}p)${t.zoneName ? ' · ' + t.zoneName : ''}` });
    }
  });
  (map.combos || []).forEach(c => {
    if (c.status === 'available') {
      options.push({ value: JSON.stringify(c.tableIds), label: `${c.name} — combinada (hasta ${c.combinedMax}p)` });
    }
  });

  sel.innerHTML = options.length
    ? '<option value="">Elige una mesa</option>' + options.map(o => `<option value='${o.value}'>${escapeHtml(o.label)}</option>`).join('')
    : '<option value="">No hay mesas libres para esa franja</option>';
}

function closeMoveModal() {
  $('moveModalBackdrop').classList.add('hidden');
  moveReservationId = null;
}

async function saveMoveModal() {
  const sel = $('moveTableSelect');
  if (!sel.value) { $('moveModalError').textContent = 'Elige una mesa.'; return; }
  const tableIds = JSON.parse(sel.value);
  const btn = $('moveModalSaveBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/reservations/${moveReservationId}/table`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableIds }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo cambiar de mesa');
    closeMoveModal();
    loadReservations();
  } catch (err) {
    $('moveModalError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// --- Modal: new reservation (phone) -----------------------------------
// Desplegable en vez de <input type="time">: evita el selector nativo del
// navegador (deja escoger cualquier minuto y "sobresale" de la ventana) y
// solo permite tramos de 15 min, iguales a los que ya usa la reserva online.
function populateTimeSelect() {
  const sel = $('mTime');
  sel.innerHTML = '<option value="">Elige una hora</option>';
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      sel.appendChild(opt);
    }
  }
}

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
  state.date = toLocalISO(d);
  $('dateFilter').value = state.date;
  loadReservations();
}

// --- Vista mensual -------------------------------------------------------
const MONTH_NAMES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const DAY_LABELS = ['L','M','X','J','V','S','D'];

function openMonthView() {
  $('dayView').classList.add('hidden');
  $('monthView').classList.remove('hidden');
  state.monthCursor = state.date.slice(0, 7);
  loadMonthView();
}
function closeMonthView() {
  $('monthView').classList.add('hidden');
  $('dayView').classList.remove('hidden');
}

function shiftMonth(delta) {
  const [y, m] = state.monthCursor.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.monthCursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  loadMonthView();
}

async function loadMonthView() {
  const [y, m] = state.monthCursor.split('-').map(Number);
  $('monthLabel').textContent = `${MONTH_NAMES[m - 1]} ${y}`;

  const firstOfMonth = new Date(y, m - 1, 1);
  const lastOfMonth = new Date(y, m, 0);
  const from = state.monthCursor + '-01';
  const to = `${y}-${String(m).padStart(2, '0')}-${String(lastOfMonth.getDate()).padStart(2, '0')}`;

  const res = await fetch(`/api/reservations/summary?restaurantId=${RESTAURANT_ID}&from=${from}&to=${to}`);
  const rows = await res.json();
  const byDate = {};
  rows.forEach(r => { byDate[r.date] = r; });

  const grid = $('monthGrid');
  grid.innerHTML = DAY_LABELS.map(l => `<div class="month-daylabel">${l}</div>`).join('');

  // Lunes=0 ... Domingo=6 para que la semana empiece en lunes, como en España.
  const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;
  for (let i = 0; i < leadingBlanks; i++) grid.innerHTML += '<div class="month-cell empty"></div>';

  for (let day = 1; day <= lastOfMonth.getDate(); day++) {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const summary = byDate[dateStr];
    const cell = document.createElement('div');
    cell.className = 'month-cell' + (dateStr === todayISO() ? ' today' : '');
    cell.innerHTML = `
      <span class="month-daynum">${day}</span>
      ${summary ? `<span class="month-covers">${summary.covers}p</span><span class="month-res">${summary.reservations} reserva${summary.reservations === 1 ? '' : 's'}</span>` : '<span class="month-res">—</span>'}
    `;
    cell.addEventListener('click', () => {
      state.date = dateStr;
      $('dateFilter').value = dateStr;
      closeMonthView();
      loadReservations();
    });
    grid.appendChild(cell);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  if (!(await guardAdminPage())) return;
  renderSessionBar($('sessionBar'));

  $('dateFilter').value = state.date;
  populateTimeSelect();
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

  $('moveModalCancelBtn').addEventListener('click', closeMoveModal);
  $('moveModalSaveBtn').addEventListener('click', saveMoveModal);

  $('monthViewBtn').addEventListener('click', openMonthView);
  $('closeMonthBtn').addEventListener('click', closeMonthView);
  $('prevMonthBtn').addEventListener('click', () => shiftMonth(-1));
  $('nextMonthBtn').addEventListener('click', () => shiftMonth(1));

  // auto-refresh every 30s to reflect reservations coming from web
  setInterval(loadReservations, 30000);
});
