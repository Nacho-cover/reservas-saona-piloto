const RESTAURANT_ID = 1;
const $ = (id) => document.getElementById(id);

const state = { plans: [], selectedPlanId: null, zones: [], tables: [], combos: [], schedule: [] };

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de red');
  return data;
}

async function loadRestaurant() {
  const r = await api(`/api/restaurants/${RESTAURANT_ID}`);
  $('restaurantName').textContent = r.name;
}

// ---- Planos --------------------------------------------------------------
async function loadPlans() {
  state.plans = await api(`/api/floor-plans?restaurantId=${RESTAURANT_ID}`);
  if (!state.selectedPlanId || !state.plans.find(p => p.id === state.selectedPlanId)) {
    const def = state.plans.find(p => p.is_default) || state.plans[0];
    state.selectedPlanId = def ? def.id : null;
  }
  renderPlans();
  await loadPlanDetail();
}

function renderPlans() {
  const list = $('plansList');
  list.innerHTML = '';
  for (const p of state.plans) {
    const row = document.createElement('div');
    row.className = 'plan-row';
    row.innerHTML = `
      <span class="plan-name">${escapeHtml(p.name)}</span>
      ${p.is_default ? '<span class="plan-badge">Por defecto</span>' : ''}
      <span class="muted-small">${p.tableCount} mesas</span>
    `;
    if (!p.is_default) {
      const btn = document.createElement('button');
      btn.textContent = 'Marcar por defecto';
      btn.addEventListener('click', () => setDefaultPlan(p.id));
      row.appendChild(btn);
    }
    list.appendChild(row);
  }

  const select = $('planSelect');
  select.innerHTML = state.plans.map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.is_default ? ' (por defecto)' : ''}</option>`).join('');
  select.value = state.selectedPlanId;

  const scheduleSelect = $('scheduleplan');
  scheduleSelect.innerHTML = state.plans.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  const cloneSelect = $('newPlanCloneFrom');
  cloneSelect.innerHTML = '<option value="">Vacío</option>' +
    state.plans.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

async function setDefaultPlan(id) {
  await api(`/api/floor-plans/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isDefault: true }),
  });
  await loadPlans();
}

// ---- Zonas, mesas, combinaciones del plano seleccionado -------------------
async function loadPlanDetail() {
  if (!state.selectedPlanId) return;
  const [zones, tables, combos] = await Promise.all([
    api(`/api/zones?restaurantId=${RESTAURANT_ID}&floorPlanId=${state.selectedPlanId}`),
    api(`/api/tables?restaurantId=${RESTAURANT_ID}&floorPlanId=${state.selectedPlanId}`),
    api(`/api/combinations?restaurantId=${RESTAURANT_ID}&floorPlanId=${state.selectedPlanId}`),
  ]);
  state.zones = zones;
  state.tables = tables;
  state.combos = combos;
  renderZones();
  renderTables();
  renderCombos();
  renderFloorPlan($('floorPlanView'), state.tables, {
    getClass: (t) => (t.zoneName === 'Barra' ? 'zone-barra' : 'zone-sala'),
  });
}

function renderZones() {
  const list = $('zonesList');
  list.innerHTML = '';
  for (const z of state.zones) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(z.name)} `;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Eliminar zona';
    del.addEventListener('click', async () => {
      await api(`/api/zones/${z.id}`, { method: 'DELETE' });
      await loadPlanDetail();
    });
    chip.appendChild(del);
    list.appendChild(chip);
  }

  const zoneSelect = $('tableZone');
  zoneSelect.innerHTML = '<option value="">Sin zona</option>' +
    state.zones.map(z => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join('');
}

function renderTables() {
  const list = $('tablesList');
  list.innerHTML = '';
  for (const t of state.tables) {
    const row = document.createElement('div');
    row.className = 'table-row';
    row.innerHTML = `
      <span class="t-name">${escapeHtml(t.name)}</span>
      <span class="t-meta">${t.zoneName ? escapeHtml(t.zoneName) + ' · ' : ''}${t.capacity_min}-${t.capacity_max}p</span>
    `;
    const del = document.createElement('button');
    del.textContent = 'Eliminar';
    del.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar la mesa ${t.name}? Las reservas ya hechas con esta mesa no se ven afectadas.`)) return;
      await api(`/api/tables/${t.id}`, { method: 'DELETE' });
      await loadPlanDetail();
    });
    row.appendChild(del);
    list.appendChild(row);
  }

  const checksContainer = $('comboTableChecks');
  checksContainer.innerHTML = state.tables.map(t => `
    <span class="chip"><label>
      <input type="checkbox" value="${t.id}"> ${escapeHtml(t.name)} (${t.capacity_max})
    </label></span>
  `).join('');
}

function renderCombos() {
  const list = $('combosList');
  list.innerHTML = '';
  if (!state.combos.length) {
    list.innerHTML = '<p class="cfg-hint">Todavía no hay combinaciones en este plano.</p>';
    return;
  }
  for (const c of state.combos) {
    const row = document.createElement('div');
    row.className = 'table-row';
    const minTxt = c.capacity_min != null ? `${c.capacity_min}-` : 'hasta ';
    row.innerHTML = `
      <span class="t-name">${escapeHtml(c.name)}</span>
      <span class="t-meta">${c.tables.map(t => escapeHtml(t.name)).join(' + ')} · ${minTxt}${c.combinedMax}p</span>
    `;
    const del = document.createElement('button');
    del.textContent = 'Eliminar';
    del.addEventListener('click', async () => {
      await api(`/api/combinations/${c.id}`, { method: 'DELETE' });
      await loadPlanDetail();
    });
    row.appendChild(del);
    list.appendChild(row);
  }
}

// ---- Agenda -----------------------------------------------------------
async function loadSchedule() {
  state.schedule = await api(`/api/floor-plan-schedule?restaurantId=${RESTAURANT_ID}`);
  renderSchedule();
}

function renderSchedule() {
  const list = $('scheduleList');
  list.innerHTML = '';
  if (!state.schedule.length) {
    list.innerHTML = '<p class="cfg-hint">No hay días con un plano distinto al de por defecto.</p>';
    return;
  }
  const planName = (id) => (state.plans.find(p => p.id === id) || {}).name || `Plano #${id}`;
  for (const s of state.schedule.sort((a, b) => a.date.localeCompare(b.date))) {
    const row = document.createElement('div');
    row.className = 'table-row';
    row.innerHTML = `
      <span class="t-name">${s.date}</span>
      <span class="t-meta">${escapeHtml(planName(s.floor_plan_id))}</span>
    `;
    const del = document.createElement('button');
    del.textContent = 'Quitar (usar por defecto)';
    del.addEventListener('click', async () => {
      await api(`/api/floor-plan-schedule?restaurantId=${RESTAURANT_ID}&date=${s.date}`, { method: 'DELETE' });
      await loadSchedule();
    });
    row.appendChild(del);
    list.appendChild(row);
  }
}

// ---- Modal: nuevo plano ------------------------------------------------
function openPlanModal() {
  $('newPlanName').value = '';
  $('newPlanCloneFrom').value = '';
  $('planModalError').textContent = '';
  $('planModalBackdrop').classList.remove('hidden');
}
function closePlanModal() { $('planModalBackdrop').classList.add('hidden'); }

async function savePlan() {
  const name = $('newPlanName').value.trim();
  const cloneFromId = $('newPlanCloneFrom').value || undefined;
  if (!name) { $('planModalError').textContent = 'Indica un nombre.'; return; }
  try {
    const plan = await api('/api/floor-plans', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId: RESTAURANT_ID, name, cloneFromId }),
    });
    closePlanModal();
    state.selectedPlanId = plan.id;
    await loadPlans();
    await loadSchedule();
  } catch (err) {
    $('planModalError').textContent = err.message;
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  if (!(await guardAdminPage())) return;
  renderSessionBar($('sessionBar'));

  await loadRestaurant();
  await loadPlans();
  await loadSchedule();

  $('planSelect').addEventListener('change', async (e) => {
    state.selectedPlanId = Number(e.target.value);
    await loadPlanDetail();
  });

  $('newPlanBtn').addEventListener('click', openPlanModal);
  $('planModalCancelBtn').addEventListener('click', closePlanModal);
  $('planModalSaveBtn').addEventListener('click', savePlan);

  $('zoneForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('zoneName').value.trim();
    if (!name) return;
    await api('/api/zones', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId: RESTAURANT_ID, floorPlanId: state.selectedPlanId, name }),
    });
    $('zoneName').value = '';
    await loadPlanDetail();
  });

  $('tableForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('tableName').value.trim();
    const zoneId = $('tableZone').value || undefined;
    const capacityMin = Number($('tableCapMin').value) || 1;
    const capacityMax = Number($('tableCapMax').value) || 4;
    if (!name) return;
    await api('/api/tables', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId: RESTAURANT_ID, floorPlanId: state.selectedPlanId, zoneId, name, capacityMin, capacityMax }),
    });
    $('tableName').value = '';
    await loadPlanDetail();
    await loadPlans(); // refresh table counts
  });

  $('comboForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('comboName').value.trim();
    const tableIds = Array.from($('comboTableChecks').querySelectorAll('input:checked')).map(el => Number(el.value));
    const capacityMin = $('comboCapMin').value ? Number($('comboCapMin').value) : undefined;
    const capacityMax = $('comboCapMax').value ? Number($('comboCapMax').value) : undefined;
    if (!name || tableIds.length < 2) {
      alert('Indica un nombre y selecciona al menos 2 mesas.');
      return;
    }
    await api('/api/combinations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId: RESTAURANT_ID, floorPlanId: state.selectedPlanId, name, tableIds, capacityMin, capacityMax }),
    });
    $('comboName').value = '';
    $('comboCapMin').value = '';
    $('comboCapMax').value = '';
    await loadPlanDetail();
  });

  $('scheduleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = $('scheduleDate').value;
    const floorPlanId = Number($('scheduleplan').value);
    if (!date || !floorPlanId) return;
    await api('/api/floor-plan-schedule', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId: RESTAURANT_ID, date, floorPlanId }),
    });
    await loadSchedule();
  });
});
