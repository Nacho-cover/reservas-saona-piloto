const RESTAURANT_ID = getRestaurantId(); // getRestaurantId() en authbar.js (selector de local)
const $ = (id) => document.getElementById(id);

const state = { date: todayISO(), reservations: [], tables: [], closures: [], shift: 'Comida', monthCursor: todayISO().slice(0, 7), moveMode: null, sheetTable: null, modalTable: null };

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
// Estados en los que el cliente está en la mesa: se puede "Liberar mesa".
const IN_TABLE = ['seated', 'eating', 'dessert', 'paid'];
async function releaseTable(id) {
  await updateStatus(id, 'completed');
}
const STATUS_LABELS = Object.fromEntries(Object.entries(STATUS_FLOW).map(([k, v]) => [k, v.label]));

async function loadRestaurant() {
  const res = await fetch(`/api/restaurants/${RESTAURANT_ID}`);
  const data = await res.json();
  $('restaurantName').textContent = data.name;
}

async function loadReservations() {
  const [resRes, tablesRes, closuresRes] = await Promise.all([
    fetch(`/api/reservations?restaurantId=${RESTAURANT_ID}&date=${state.date}`),
    fetch(`/api/tables?restaurantId=${RESTAURANT_ID}&date=${state.date}&shift=${encodeURIComponent(state.shift)}`),
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
  // Sin permiso de cierres (rol Sala) solo se informa, sin botones.
  if (!hasPerm('closures')) {
    bar.innerHTML = dayClosed
      ? `<div class="closure-bar closed">🔒 Todo el día ${state.date} está cerrado a reservas nuevas.</div>`
      : shiftClosure
        ? `<div class="closure-bar closed">🔒 Turno de ${state.shift} cerrado a reservas nuevas.</div>`
        : `<div class="closure-bar">Turno de ${state.shift} abierto a reservas.</div>`;
    return;
  }

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
  // Las reservas completadas (mesa liberada) ya no ocupan la mesa en el plano.
  shiftReservations.filter(r => r.status !== 'completed').forEach(r => (r.tables || []).forEach(name => tableStatus.set(name, r.status)));
  const busyTableNames = new Set(tableStatus.keys());

  const mv = state.moveMode;
  renderFloorPlan($('floorPlanView'), state.tables, {
    getClass: (t) => {
      if (mv) {
        if ((mv.reservation.tables || []).includes(t.name)) return 'fp-source';
        const st = mv.statusById[t.id];
        if (st === 'available') return 'fp-target';
        if (st === 'toosmall') return 'fp-target-warn';
        if (st === 'occupied') return 'fp-swap';
        return 'fp-dim';
      }
      const status = tableStatus.get(t.name);
      if (!status) return '';
      return (STATUS_FLOW[status] && STATUS_FLOW[status].color) || 'status-busy';
    },
    // El muro, la escalera y las etiquetas de zona son del plano de Plaza España;
    // en el resto de locales no se dibujan.
    getInfo: (t) => {
      if (mv) return null;
      const list = reservationsForTable(t).filter(r => r.status !== 'completed');
      if (!list.length) return null;
      const r = reservationToDrag(t);
      const first = `${r.time} · ${r.party_size}p${list.length > 1 ? ` (+${list.length - 1})` : ''}`;
      let name = r.source === 'walkin' && (!r.customer_name || r.customer_name === 'Walk-in') ? 'Walk-in' : r.customer_name.split(' ')[0];
      // Avisos del cliente en la propia mesa: ★ VIP, ⚠ lista negra, no-show o alergias.
      const c = r.customer;
      if (c) {
        if ((c.tags || []).includes('vip')) name = '★ ' + name;
        if ((c.tags || []).includes('blacklist') || c.noShows || (c.allergies || []).length) name = '⚠ ' + name;
      }
      return [first, name];
    },
    features: RESTAURANT_ID === 1 ? SALA_INTERIOR_FEATURES : [],
    zoneLabels: RESTAURANT_ID === 1 ? SALA_INTERIOR_ZONE_LABELS : [],
    onClick: (t) => (state.moveMode ? handleMoveTarget(t) : openTableSheet(t)),
    // Arrastrar una mesa con reserva y soltarla en otra = mover (o intercambiar si
    // la de destino está ocupada a esa hora).
    canDrag: (t) => !state.moveMode && !!reservationToDrag(t),
    onDrop: (from, to) => { const r = reservationToDrag(from); if (r) moveOrSwap(r, to); },
  });
  renderMoveBanner();

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
    <div class="res-name">${r.phone ? `<button type="button" class="res-cust-link" title="Ver ficha del cliente">${escapeHtml(r.customer_name)}</button>` : escapeHtml(r.customer_name)} · ${r.party_size}p ${r.tables && r.tables.length ? `· Mesa ${r.tables.join(', ')}` : ''}</div>
    ${customerChips(r.customer)}
    <div class="res-meta">${r.phone || ''} ${r.notes ? '· ' + escapeHtml(r.notes) : ''}</div>
  `;
  info.querySelector('.res-cust-link')?.addEventListener('click', () => openCustomerCard(r.phone, loadReservations));

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
  badge.textContent = r.status === 'confirmed' ? (r.source === 'phone' || r.source === 'admin' ? 'Tel.' : 'Web') : (r.source === 'walkin' && r.status === 'seated' ? 'Walk-in' : statusText);

  const actions = document.createElement('div');
  actions.className = 'res-actions';
  if (r.status !== 'cancelled' && r.status !== 'completed' && r.status !== 'no_show') {
    if (flow.next && flow.next !== 'completed') {
      actions.appendChild(actionBtn(flow.nextLabel, () => updateStatus(r.id, flow.next)));
    }
    if (IN_TABLE.includes(r.status)) actions.appendChild(actionBtn('Liberar mesa', () => releaseTable(r.id), 'btn-release'));
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
  await loadReservations();
}

async function cancelReservation(id, cancelledBy) {
  const who = cancelledBy === 'restaurant' ? 'el restaurante' : 'el cliente';
  if (!confirm(`¿Cancelar esta reserva? (cancela ${who})`)) return false;
  await fetch(`/api/reservations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled', cancelledBy }),
  });
  await loadReservations();
  return true;
}

async function markNoShow(id) {
  if (!confirm('¿Marcar como no-show? (el cliente reservó y no se presentó)')) return;
  await updateStatus(id, 'no_show');
}

// --- Modal: cambiar de mesa una reserva ya existente --------------------
// ===== Ficha de mesa: al pinchar una mesa del plano ===========================
// Muestra las reservas de esa mesa en el turno elegido (con su siguiente paso y
// "Mover a otra mesa") y, si se quiere, permite sentar un walk-in o hacer una
// reserva directamente en esa mesa.

function reservationsForTable(t) {
  return state.reservations
    .filter(r => r.status !== 'cancelled' && r.status !== 'no_show' && shiftLabel(r.time) === state.shift
      && (r.tables || []).includes(t.name))
    .sort((a, b) => a.time.localeCompare(b.time));
}

function nowHHMM(exact = false) {
  const d = new Date();
  const m = exact ? d.getMinutes() : Math.floor(d.getMinutes() / 5) * 5; // redondeo a 5 min
  return `${String(d.getHours()).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function openTableSheet(t) {
  state.sheetTable = t;
  const list = reservationsForTable(t).filter(r => r.status !== 'completed'); // las ya liberadas no se muestran
  const isToday = state.date === todayISO();
  const sheet = $('tableSheet');
  const resHtml = list.length ? list.map(r => {
    const flow = STATUS_FLOW[r.status] || {};
    const canAct = !['completed', 'cancelled', 'no_show'].includes(r.status);
    const otherTables = (r.tables || []).filter(n => n !== t.name);
    return `<div class="ts-res" data-id="${r.id}">
      <div class="ts-res-top">
        <div><span class="ts-res-name">${r.time} · ${escapeHtml(r.customer_name)}</span> · ${r.party_size}p</div>
        <span class="res-badge ${flow.color || ''}">${escapeHtml(STATUS_LABELS[r.status] || r.status)}</span>
      </div>
      ${customerChips(r.customer)}
      <div class="ts-res-meta">${r.source === 'walkin' ? 'Walk-in' : (r.phone ? escapeHtml(r.phone) : '')}${otherTables.length ? ' · junto con mesa ' + otherTables.map(escapeHtml).join(', ') : ''}${r.notes ? ' · ' + escapeHtml(r.notes) : ''}</div>
      ${canAct ? `<div class="ts-res-actions">
        ${flow.next && flow.next !== 'completed' ? `<button class="primary" data-act="next">${escapeHtml(flow.nextLabel)}</button>` : ''}
        ${IN_TABLE.includes(r.status) ? `<button class="btn-release" data-act="release">Liberar mesa</button>` : ''}
        <button class="btn-move" data-act="move">Mover o intercambiar</button>
        <button class="btn-move" data-act="join">Juntar mesas…</button>
        <button class="btn-noshow" data-act="noshow">No-show</button>
        <button class="btn-cancel-restaurant" data-act="cancel-restaurant">Cancela restaurante</button>
        <button class="btn-cancel-customer" data-act="cancel-customer">Cancela cliente</button>
      </div>` : ''}
      ${r.phone ? '<div class="ts-res-actions"><button data-act="customer">Ficha del cliente</button></div>' : ''}
    </div>`;
  }).join('') : '<p class="ts-empty">Sin reservas en esta mesa en el turno de ' + escapeHtml(state.shift) + '.</p>';

  const defaultParty = Math.min(Math.max(2, t.capacity_min || 1), t.capacity_max || 2);
  sheet.innerHTML = `
    <h2>Mesa ${escapeHtml(t.name)}</h2>
    <p class="ts-sub">${t.capacity_min}-${t.capacity_max} personas${t.zoneName ? ' · ' + escapeHtml(t.zoneName) : ''} · ${escapeHtml(state.shift)} del ${state.date}</p>
    <div class="ts-section-title">Reservas en esta mesa</div>
    ${resHtml}
    <div class="ts-section-title">Añadir en esta mesa</div>
    ${isToday && shiftLabel(nowHHMM()) !== state.shift ? `<p class="ts-empty">Estás viendo la ${escapeHtml(state.shift.toLowerCase())}; el walk-in se sienta ahora (${escapeHtml(shiftLabel(nowHHMM()).toLowerCase())}) y el plano pasará a ese turno.</p>` : ''}
    ${isToday ? `<div class="ts-add">
      <label class="field"><span>Comensales</span><input type="number" id="wiParty" min="1" value="${defaultParty}"></label>
      <label class="field wide"><span>Nombre (opcional)</span><input type="text" id="wiName" placeholder="Walk-in"></label>
      <button class="primary" id="wiBtn">Sentar walk-in ahora</button>
    </div>` : '<p class="ts-empty">Los walk-in solo se pueden sentar en el día de hoy.</p>'}
    <div class="ts-add" style="margin-top:10px">
      <button id="tsNewResBtn">+ Nueva reserva en esta mesa</button>
    </div>
    <p class="ts-error" id="tsError"></p>
    <div class="modal-actions"><button class="btn btn-secondary" id="tsCloseBtn">Cerrar</button></div>`;

  sheet.querySelectorAll('.ts-res').forEach(el => {
    const r = list.find(x => String(x.id) === el.dataset.id);
    el.querySelector('[data-act="next"]')?.addEventListener('click', async () => {
      await updateStatus(r.id, STATUS_FLOW[r.status].next);
      reopenSheet();
    });
    el.querySelector('[data-act="move"]')?.addEventListener('click', () => startMove(r));
    el.querySelector('[data-act="customer"]')?.addEventListener('click', () => openCustomerCard(r.phone, async () => { await loadReservations(); reopenSheet(); }));
    el.querySelector('[data-act="release"]')?.addEventListener('click', async () => {
      await releaseTable(r.id);
      closeTableSheet();
    });
    el.querySelector('[data-act="join"]')?.addEventListener('click', () => { closeTableSheet(); openMoveModal(r); });
    el.querySelector('[data-act="noshow"]')?.addEventListener('click', async () => {
      if (!confirm('¿Marcar como no-show? (el cliente reservó y no se presentó)')) return;
      await updateStatus(r.id, 'no_show');
      reopenSheet();
    });
    for (const who of ['restaurant', 'customer']) {
      el.querySelector(`[data-act="cancel-${who}"]`)?.addEventListener('click', async () => {
        if (!(await cancelReservation(r.id, who))) return;
        reopenSheet();
      });
    }
  });
  $('wiBtn')?.addEventListener('click', () => seatWalkIn(t));
  $('tsNewResBtn').addEventListener('click', () => { closeTableSheet(); openModal(t); });
  $('tsCloseBtn').addEventListener('click', closeTableSheet);
  $('tableSheetBackdrop').classList.remove('hidden');
}

function reopenSheet() {
  if (!state.sheetTable) return;
  const t = state.tables.find(x => x.id === state.sheetTable.id) || state.sheetTable;
  openTableSheet(t);
}

function closeTableSheet() {
  $('tableSheetBackdrop').classList.add('hidden');
  state.sheetTable = null;
}

// Si los comensales no encajan con la mesa, se pregunta antes (como el aviso de Cover)
// y se manda force: true para que el servidor no lo rechace por capacidad.
function confirmCapacity(t, partySize) {
  if (partySize >= t.capacity_min && partySize <= t.capacity_max) return { ok: true, force: false };
  const ok = window.confirm(`La mesa ${t.name} es para ${t.capacity_min}-${t.capacity_max} personas y son ${partySize}. ¿Seguir igualmente?`);
  return { ok, force: ok };
}

// Cambia el turno que se ve en el plano (y marca el botón Comida/Cena).
function setShift(shift, reload = true) {
  state.shift = shift;
  $('fpShiftToggle').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.shift === shift));
  return reload ? loadReservations() : Promise.resolve();
}

async function seatWalkIn(t) {
  const partySize = Number($('wiParty').value);
  if (!partySize || partySize < 1) { $('tsError').textContent = 'Indica cuántos comensales son.'; return; }
  const cap = confirmCapacity(t, partySize);
  if (!cap.ok) return;
  const btn = $('wiBtn');
  const time = nowHHMM(true); // minuto exacto: así cabe justo después de liberar la mesa
  btn.disabled = true;
  try {
    const res = await fetch('/api/reservations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: RESTAURANT_ID, customerName: $('wiName').value.trim() || 'Walk-in',
        partySize, date: todayISO(), time, source: 'walkin', tableIds: [t.id], force: cap.force,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo sentar el walk-in');
    // El walk-in se sienta a la hora actual: si estábamos viendo el otro turno, se
    // salta al turno de ahora para que la mesa aparezca ocupada.
    if (state.date !== todayISO()) { state.date = todayISO(); $('dateFilter').value = state.date; }
    await setShift(shiftLabel(time));
    reopenSheet();
  } catch (err) {
    $('tsError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ===== Mover una reserva pinchando la mesa de destino en el plano ===============
async function startMove(r) {
  closeTableSheet();
  const params = new URLSearchParams({
    restaurantId: RESTAURANT_ID, date: r.date, time: r.time, partySize: r.party_size,
    excludeReservationId: r.id, durationMinutes: r.duration_minutes,
  });
  let statusById = {};
  try {
    const res = await fetch(`/api/table-map?${params}`);
    const map = await res.json();
    (map.tables || []).forEach(t => { statusById[t.id] = t.status; });
  } catch { /* sin mapa: todas se intentan y el servidor valida */ }
  state.moveMode = { reservation: r, statusById, error: '' };
  renderFloorPlanView();
  $('moveBanner').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelMove() {
  state.moveMode = null;
  renderFloorPlanView();
}

function renderMoveBanner() {
  const el = $('moveBanner');
  const mv = state.moveMode;
  if (!mv) { el.innerHTML = ''; return; }
  const r = mv.reservation;
  el.innerHTML = `<div class="move-banner">
    <span>Moviendo <b>${escapeHtml(r.customer_name)}</b> (${r.party_size}p, ${r.time}, mesa ${escapeHtml((r.tables || []).join(', ') || '—')}): pincha la mesa de destino: en verde las libres; en naranja las ocupadas (se intercambian).</span>
    <span class="mb-actions">
      <button id="mbComboBtn">Juntar mesas…</button>
      <button id="mbCancelBtn">Cancelar</button>
    </span>
    <span class="mb-error">${escapeHtml(mv.error || '')}</span>
  </div>`;
  $('mbCancelBtn').addEventListener('click', cancelMove);
  $('mbComboBtn').addEventListener('click', () => { const res = mv.reservation; cancelMove(); openMoveModal(res); });
}

async function handleMoveTarget(t) {
  const mv = state.moveMode;
  if (!mv) return;
  if ((mv.reservation.tables || []).includes(t.name)) { cancelMove(); return; }
  const err = await moveOrSwap(mv.reservation, t);
  if (err && state.moveMode) { state.moveMode.error = err; renderMoveBanner(); }
}

// La reserva que se arrastra desde una mesa: si hay varias en el turno, la que está
// en curso (sentada, comiendo…) y si no, la próxima por llegar.
function reservationToDrag(t) {
  const list = reservationsForTable(t).filter(r => r.status !== 'completed');
  return list.find(r => ['seated', 'eating', 'dessert', 'paid'].includes(r.status)) || list[0] || null;
}

function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }

// Reservas de la mesa de destino que se solapan en horario con la que se mueve.
function conflictsOn(t, r) {
  const s = toMin(r.time), e = s + (r.duration_minutes || 90);
  return state.reservations.filter(x => x.id !== r.id && !['cancelled', 'no_show', 'completed'].includes(x.status)
    && (x.tables || []).includes(t.name)
    && toMin(x.time) < e && s < toMin(x.time) + (x.duration_minutes || 90));
}

// Mover r a la mesa t; si t tiene otra reserva a esa hora, se ofrece intercambiarlas.
// Devuelve un texto de error (o null si ha ido bien o se ha cancelado).
async function moveOrSwap(r, t) {
  if ((r.tables || []).includes(t.name)) return null;
  const others = conflictsOn(t, r);
  try {
    if (others.length > 1) return `La mesa ${t.name} tiene varias reservas a esa hora; muévelas de una en una.`;
    if (others.length === 1) {
      const o = others[0];
      const msg = `La mesa ${t.name} tiene la reserva de ${o.customer_name} (${o.party_size}p, ${o.time}).\n\n`
        + `¿Intercambiar? ${r.customer_name} pasa a la mesa ${(o.tables || []).join('+')} y ${o.customer_name} a la mesa ${(r.tables || []).join('+') || '—'}.`;
      if (!window.confirm(msg)) return null;
      const res = await fetch('/api/reservations/swap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationIdA: r.id, reservationIdB: o.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo intercambiar');
    } else {
      const cap = confirmCapacity(t, r.party_size);
      if (!cap.ok) return null;
      const res = await fetch(`/api/reservations/${r.id}/table`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableIds: [t.id], force: cap.force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo mover la reserva');
    }
    state.moveMode = null;
    await loadReservations();
    return null;
  } catch (err) {
    if (!state.moveMode) toast(err.message);
    return err.message;
  }
}

function toast(text) {
  let el = document.getElementById('adminToast');
  if (!el) { el = document.createElement('div'); el.id = 'adminToast'; el.className = 'admin-toast'; document.body.appendChild(el); }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}

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
// Las horas salen del horario real del local para la fecha elegida (turnos de ese día,
// excepciones por fecha y cierres), con la misma última hora que la web. La casilla
// "Fuera de horario" vuelve a dar todas las horas del día para casos excepcionales.
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

let slotsRequest = 0;
async function loadModalSlots() {
  const sel = $('mTime');
  const hint = $('mTimeHint');
  const previous = sel.value;
  if ($('mAnyTime').checked) {
    populateTimeSelect();
    hint.textContent = 'Todas las horas del día (fuera del horario del local).';
    if (previous) sel.value = previous;
    return;
  }
  const date = $('mDate').value;
  if (!date) { sel.innerHTML = '<option value="">Elige primero la fecha</option>'; hint.textContent = ''; return; }
  const reqId = ++slotsRequest;
  sel.innerHTML = '<option value="">Cargando horario…</option>';
  sel.disabled = true;
  try {
    const res = await fetch(`/api/shifts/slots?restaurantId=${RESTAURANT_ID}&date=${date}`);
    const data = await res.json();
    if (reqId !== slotsRequest) return; // se cambió la fecha mientras tanto
    if (!res.ok) throw new Error(data.error || 'No se pudo cargar el horario');
    sel.innerHTML = '<option value="">Elige una hora</option>';
    const withSlots = data.shifts.filter(s => s.slots.length);
    for (const s of withSlots) {
      const group = document.createElement('optgroup');
      group.label = `${s.name} (${s.start}–${s.lastSeating})${s.closed ? ' · web cerrada' : ''}`;
      for (const t of s.slots) {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        group.appendChild(opt);
      }
      sel.appendChild(group);
    }
    if (!withSlots.length) {
      sel.innerHTML = '<option value="">El local no abre ese día</option>';
      hint.textContent = 'No hay turnos ese día. Marca «Fuera de horario» si aun así hay que apuntarla.';
    } else {
      const closedNames = withSlots.filter(s => s.closed).map(s => s.name.toLowerCase());
      hint.textContent = closedNames.length
        ? `Ese día la reserva web está cerrada en ${closedNames.join(' y ')}; por teléfono se puede apuntar igual.`
        : '';
    }
    if (previous && [...sel.options].some(o => o.value === previous)) sel.value = previous;
  } catch (err) {
    if (reqId !== slotsRequest) return;
    populateTimeSelect();
    hint.textContent = 'No se pudo cargar el horario del local; se muestran todas las horas.';
  } finally {
    if (reqId === slotsRequest) sel.disabled = false;
  }
}

function openModal(table) {
  // Con mesa (desde la ficha de mesa del plano) la reserva va a esa mesa; sin mesa
  // se asigna sola, como siempre.
  state.modalTable = table && table.id ? table : null;
  $('modalTitle').textContent = state.modalTable ? `Nueva reserva · mesa ${state.modalTable.name}` : 'Nueva reserva (teléfono)';
  $('mName').value = '';
  $('mPhone').value = '';
  $('mEmail').value = '';
  $('mCustomerInfo').innerHTML = '';
  $('mDate').value = state.date;
  $('mTime').value = '';
  $('mAnyTime').checked = false;
  $('mParty').value = 2;
  $('mNotes').value = '';
  $('modalError').textContent = '';
  $('modalBackdrop').classList.remove('hidden');
  loadModalSlots();
}
function closeModal() {
  $('modalBackdrop').classList.add('hidden');
  state.modalTable = null;
}

async function saveModal() {
  const customerName = $('mName').value.trim();
  const phone = $('mPhone').value.trim();
  const email = $('mEmail').value.trim();
  const date = $('mDate').value;
  const time = $('mTime').value;
  const partySize = Number($('mParty').value);
  const notes = $('mNotes').value.trim();

  if (!customerName || !date || !time || !partySize) {
    $('modalError').textContent = 'Completa nombre, fecha, hora y comensales.';
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    $('modalError').textContent = 'El email no parece correcto. Revísalo o déjalo en blanco.';
    return;
  }

  const t = state.modalTable;
  let tablePart = {};
  if (t) {
    const cap = confirmCapacity(t, partySize);
    if (!cap.ok) return;
    tablePart = { tableIds: [t.id], force: cap.force };
  }

  const btn = $('modalSaveBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: RESTAURANT_ID, customerName, phone, email: email || undefined, partySize, date, time, notes, source: 'phone', ...tablePart,
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
  state.monthRows = { from, to, rows };
  const byDate = {};
  rows.forEach(r => { byDate[r.date] = r; });

  // Totales del mes por turno.
  const tot = rows.reduce((a, r) => ({
    lr: a.lr + (r.lunch_reservations || 0), lc: a.lc + (r.lunch_covers || 0),
    dr: a.dr + (r.dinner_reservations || 0), dc: a.dc + (r.dinner_covers || 0),
  }), { lr: 0, lc: 0, dr: 0, dc: 0 });
  const plural = (n) => `${n} reserva${n === 1 ? '' : 's'}`;
  $('monthTotals').innerHTML = `
    <span class="month-tot"><span class="shift-dot lunch"></span>Comida: <b>${tot.lc} p</b> · ${plural(tot.lr)}</span>
    <span class="month-tot"><span class="shift-dot dinner"></span>Cena: <b>${tot.dc} p</b> · ${plural(tot.dr)}</span>
    <span class="month-tot">Total: <b>${tot.lc + tot.dc} p</b> · ${plural(tot.lr + tot.dr)}</span>`;

  const shiftLine = (cls, label, covers, res) => covers || res
    ? `<span class="month-shift ${cls}" title="${label}: ${covers} comensales, ${plural(res)}"><span class="shift-dot ${cls}"></span><span class="ms-label">${label}</span> <b>${covers}p</b> <span class="ms-res">· ${res}r</span></span>`
    : `<span class="month-shift ${cls} zero"><span class="shift-dot ${cls}"></span><span class="ms-label">${label}</span> —</span>`;

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
      ${summary
        ? shiftLine('lunch', 'Comida', summary.lunch_covers, summary.lunch_reservations)
          + shiftLine('dinner', 'Cena', summary.dinner_covers, summary.dinner_reservations)
          + `<span class="month-res">Total ${summary.covers}p · ${summary.reservations}r</span>`
        : '<span class="month-res">—</span>'}
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

// --- Excel del día y del mes (roles con informes) ---------------------------------
const CANAL_LABELS = { web: 'Web', app: 'App', phone: 'Teléfono', admin: 'Panel', walkin: 'Walk-in' };
function restaurantSlug() {
  return ($('restaurantName').textContent || 'local').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function xlsxSheet(columns, rows) {
  const ws = XLSX.utils.aoa_to_sheet([columns, ...rows]);
  ws['!cols'] = columns.map((c, i) => ({
    wch: Math.min(Math.max(String(c).length, ...rows.slice(0, 200).map(r => String(r[i] ?? '').length)) + 2, 50),
  }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  return ws;
}
function xlsxOk() {
  if (window.XLSX) return true;
  alert('No se ha podido cargar el generador de Excel. Recarga la página.');
  return false;
}

function downloadDayXlsx() {
  if (!xlsxOk()) return;
  const columns = ['Fecha', 'Hora', 'Turno', 'Cliente', 'Comensales', 'Mesa', 'Estado', 'Cancelada por', 'Canal', 'Teléfono', 'Email', 'Notas',
    'Etiquetas', 'Alergias', 'No-shows (grupo)', 'Visitas (grupo)'];
  const rows = [...state.reservations]
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(r => [r.date, r.time, shiftLabel(r.time), r.customer_name, r.party_size, (r.tables || []).join('+'),
      STATUS_LABELS[r.status] || r.status,
      r.status === 'cancelled' ? ({ customer: 'Cliente', restaurant: 'Restaurante' }[r.cancelled_by] || '') : '',
      CANAL_LABELS[r.source] || r.source, r.phone || '', r.email || '', r.notes || '',
      r.customer ? (r.customer.tags || []).map(t => CUST_TAG_LABELS[t] || t).join(', ') : '',
      r.customer ? (r.customer.allergies || []).join(', ') : '',
      r.customer ? r.customer.noShows : '', r.customer ? r.customer.visits : '']);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, xlsxSheet(columns, rows), 'Reservas');
  XLSX.writeFile(wb, `reservas-${restaurantSlug()}-${state.date}.xlsx`, { compression: true });
}

function downloadMonthXlsx() {
  if (!xlsxOk() || !state.monthRows) return;
  const { from, to, rows } = state.monthRows;
  const byDate = Object.fromEntries(rows.map(r => [r.date, r]));
  const out = [];
  for (let d = new Date(from + 'T00:00:00'); ; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (key > to) break;
    const r = byDate[key];
    out.push([key, d.toLocaleDateString('es-ES', { weekday: 'long' }),
      r ? r.lunch_reservations : 0, r ? r.lunch_covers : 0,
      r ? r.dinner_reservations : 0, r ? r.dinner_covers : 0,
      r ? r.reservations : 0, r ? r.covers : 0]);
  }
  const total = ['Total', ''];
  for (let i = 2; i < 8; i++) total.push(out.reduce((acc, r) => acc + r[i], 0));
  out.push(total);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, xlsxSheet(['Día', 'Día de la semana',
    'Reservas comida', 'Comensales comida', 'Reservas cena', 'Comensales cena',
    'Reservas total (sin canceladas)', 'Comensales total'], out), 'Mes');
  XLSX.writeFile(wb, `reservas-mes-${restaurantSlug()}-${from.slice(0, 7)}.xlsx`, { compression: true });
}

window.addEventListener('DOMContentLoaded', async () => {
  if (!(await guardAdminPage('reservations'))) return;
  renderSessionBar($('sessionBar'));
  renderRestaurantBar($('restaurantBar'));

  $('dateFilter').value = state.date;
  // Al abrir el panel se muestra el turno en curso (a partir de las 18:00, la cena).
  setShift(shiftLabel(nowHHMM()), false);
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
    // Cada turno puede usar un plano distinto (p. ej. Máximos en comida, Mínimos en cena).
    loadReservations();
  });

  $('openNewBtn').addEventListener('click', () => openModal());
  $('modalCancelBtn').addEventListener('click', closeModal);
  $('mDate').addEventListener('change', loadModalSlots);
  watchPhoneForCustomer();
  $('custBackdrop').addEventListener('click', (e) => { if (e.target.id === 'custBackdrop') closeCustomerCard(); });
  $('mAnyTime').addEventListener('change', loadModalSlots);
  $('modalSaveBtn').addEventListener('click', saveModal);

  $('moveModalCancelBtn').addEventListener('click', closeMoveModal);
  $('tableSheetBackdrop').addEventListener('click', (e) => { if (e.target.id === 'tableSheetBackdrop') closeTableSheet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('tableSheetBackdrop').classList.contains('hidden')) closeTableSheet();
    else if (state.moveMode) cancelMove();
  });
  $('moveModalSaveBtn').addEventListener('click', saveMoveModal);

  $('monthViewBtn').addEventListener('click', openMonthView);
  $('dayXlsxBtn').addEventListener('click', downloadDayXlsx);
  $('monthXlsxBtn').addEventListener('click', downloadMonthXlsx);
  $('closeMonthBtn').addEventListener('click', closeMonthView);
  $('prevMonthBtn').addEventListener('click', () => shiftMonth(-1));
  $('nextMonthBtn').addEventListener('click', () => shiftMonth(1));

  // auto-refresh every 30s to reflect reservations coming from web
  setInterval(loadReservations, 30000);
});
