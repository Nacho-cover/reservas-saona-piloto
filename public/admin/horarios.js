const RESTAURANT_ID = 1;
const $ = (id) => document.getElementById(id);

// day_of_week: 0=domingo ... 6=sábado (igual que en toda la app). Se muestra en
// orden lunes-primero, como en Cover.
const DIAS = [
  { dow: 1, label: 'lunes' }, { dow: 2, label: 'martes' }, { dow: 3, label: 'miércoles' },
  { dow: 4, label: 'jueves' }, { dow: 5, label: 'viernes' }, { dow: 6, label: 'sábado' },
  { dow: 0, label: 'domingo' },
];

const state = { shifts: [], overrides: [], specificDates: [] };

function populateHourSelect(sel) {
  sel.innerHTML = '';
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

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadAll() {
  const [shiftsRes, overridesRes] = await Promise.all([
    fetch(`/api/shifts?restaurantId=${RESTAURANT_ID}`),
    fetch(`/api/shift-date-overrides?restaurantId=${RESTAURANT_ID}&from=${todayISO()}&to=${addDays(todayISO(), 60)}`),
  ]);
  state.shifts = await shiftsRes.json();
  state.overrides = await overridesRes.json();
  renderWeekGrid();
  renderShiftNameSelect();
  renderOverridesList();
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// --- Horario semanal (rejilla) ------------------------------------------------
function renderWeekGrid() {
  const grid = $('weekGrid');
  grid.innerHTML = '';
  for (const { dow, label } of DIAS) {
    const col = document.createElement('div');
    col.className = 'week-day';
    const shiftsThisDay = state.shifts.filter(s => s.day_of_week === dow).sort((a, b) => a.start_time.localeCompare(b.start_time));
    col.innerHTML = `<div class="wd-label">${label}</div>` + (
      shiftsThisDay.length
        ? shiftsThisDay.map(s => `<div class="wd-shift" data-id="${s.id}">${escapeHtml(s.name)}<br>${s.start_time}–${s.end_time}</div>`).join('')
        : '<div class="wd-empty">Cerrado</div>'
    );
    col.querySelectorAll('.wd-shift').forEach(el => {
      el.addEventListener('click', () => {
        const shift = state.shifts.find(s => s.id === Number(el.dataset.id));
        if (shift) prefillForm(shift);
      });
    });
    grid.appendChild(col);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function prefillForm(shift) {
  $('shiftName').value = shift.name;
  $('shiftStart').value = shift.start_time;
  $('shiftEnd').value = shift.end_time;
  document.querySelector('input[name="scope"][value="weekday"]').checked = true;
  state.selectedWeekday = shift.day_of_week;
  updateWeekdayLabel();
  renderScopeFields();
  window.scrollTo({ top: document.querySelector('#shiftForm').offsetTop - 20, behavior: 'smooth' });
}

// --- Selector de turno (con opción "nuevo turno") -----------------------------
function renderShiftNameSelect() {
  const names = [...new Set(state.shifts.map(s => s.name))];
  const sel = $('shiftName');
  const current = sel.value;
  sel.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')
    + '<option value="__new__">+ Nuevo turno…</option>';
  if (names.includes(current)) sel.value = current;
  toggleNewShiftInput();
}
function toggleNewShiftInput() {
  const isNew = $('shiftName').value === '__new__';
  $('shiftNameNew').classList.toggle('hidden', !isNew);
}
function currentShiftName() {
  return $('shiftName').value === '__new__' ? $('shiftNameNew').value.trim() : $('shiftName').value;
}

// --- Campos según el "aplicar a" elegido --------------------------------------
function updateWeekdayLabel() {
  const dow = state.selectedWeekday != null ? state.selectedWeekday : new Date().getDay();
  const dia = DIAS.find(d => d.dow === dow) || DIAS[0];
  $('weekdayLabel').textContent = dia.label;
}

function renderScopeFields() {
  const scope = document.querySelector('input[name="scope"]:checked').value;
  const box = $('scopeFields');
  if (scope === 'day') {
    box.innerHTML = `<label class="field"><span>Fecha</span><input type="date" id="scopeDate" value="${todayISO()}"></label>`;
  } else if (scope === 'weekday') {
    box.innerHTML = `<label class="field"><span>Día de la semana</span>
      <select id="scopeWeekday">${DIAS.map(d => `<option value="${d.dow}">${cap(d.label)}</option>`).join('')}</select></label>`;
    box.querySelector('#scopeWeekday').value = state.selectedWeekday != null ? state.selectedWeekday : new Date().getDay();
    box.querySelector('#scopeWeekday').addEventListener('change', (e) => {
      state.selectedWeekday = Number(e.target.value);
      updateWeekdayLabel();
    });
    state.selectedWeekday = Number(box.querySelector('#scopeWeekday').value);
    updateWeekdayLabel();
  } else if (scope === 'everyday') {
    box.innerHTML = '';
  } else if (scope === 'range') {
    box.innerHTML = `
      <div class="field-row">
        <label class="field"><span>Desde</span><input type="date" id="scopeFrom" value="${todayISO()}"></label>
        <label class="field"><span>Hasta</span><input type="date" id="scopeTo" value="${todayISO()}"></label>
      </div>`;
  } else if (scope === 'specific') {
    state.specificDates = [];
    box.innerHTML = `
      <div class="field-row">
        <label class="field"><span>Añadir fecha</span><input type="date" id="scopeAddDate" value="${todayISO()}"></label>
        <button class="btn btn-secondary" type="button" id="scopeAddDateBtn" style="align-self:flex-end">+ Añadir</button>
      </div>
      <div class="date-list" id="scopeDateList"></div>`;
    box.querySelector('#scopeAddDateBtn').addEventListener('click', () => {
      const date = box.querySelector('#scopeAddDate').value;
      if (date && !state.specificDates.includes(date)) {
        state.specificDates.push(date);
        renderSpecificDateChips();
      }
    });
  }
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function renderSpecificDateChips() {
  const list = $('scopeDateList');
  if (!list) return;
  list.innerHTML = state.specificDates.map(d => `<span class="chip">${d} <button type="button" data-date="${d}">✕</button></span>`).join('');
  list.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    state.specificDates = state.specificDates.filter(d => d !== b.dataset.date);
    renderSpecificDateChips();
  }));
}

// Convierte el "aplicar a" elegido en una lista de fechas concretas (para
// day/range/specific) o en una lista de day_of_week (para weekday/everyday).
function resolveScope() {
  const scope = document.querySelector('input[name="scope"]:checked').value;
  if (scope === 'day') {
    const date = $('scopeDate').value;
    if (!date) throw new Error('Elige una fecha.');
    return { kind: 'dates', dates: [date] };
  }
  if (scope === 'range') {
    const from = $('scopeFrom').value, to = $('scopeTo').value;
    if (!from || !to || from > to) throw new Error('Elige un rango de fechas válido.');
    const dates = [];
    let d = from;
    while (d <= to) { dates.push(d); d = addDays(d, 1); }
    return { kind: 'dates', dates };
  }
  if (scope === 'specific') {
    if (!state.specificDates.length) throw new Error('Añade al menos una fecha.');
    return { kind: 'dates', dates: [...state.specificDates] };
  }
  if (scope === 'weekday') {
    return { kind: 'weekdays', weekdays: [Number($('scopeWeekday').value)] };
  }
  // everyday
  return { kind: 'weekdays', weekdays: DIAS.map(d => d.dow) };
}

// --- Guardar horario / cerrar turno --------------------------------------------
async function applyHours(e) {
  e.preventDefault();
  const errorEl = $('shiftFormError');
  errorEl.textContent = '';
  const name = currentShiftName();
  const startTime = $('shiftStart').value;
  const endTime = $('shiftEnd').value;
  if (!name) { errorEl.textContent = 'Indica el nombre del turno.'; return; }
  if (startTime >= endTime) { errorEl.textContent = 'La hora de inicio debe ser antes que la de fin.'; return; }

  let target;
  try { target = resolveScope(); } catch (err) { errorEl.textContent = err.message; return; }

  try {
    if (target.kind === 'weekdays') {
      for (const dayOfWeek of target.weekdays) {
        const res = await fetch('/api/shifts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantId: RESTAURANT_ID, name, dayOfWeek, startTime, endTime }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'No se pudo guardar el turno');
      }
    } else {
      const res = await fetch('/api/shift-date-overrides', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId: RESTAURANT_ID, dates: target.dates, shiftName: name, startTime, endTime }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudo guardar la excepción');
    }
    await loadAll();
    errorEl.style.color = 'var(--brand-dark)';
    errorEl.textContent = 'Horario guardado.';
    setTimeout(() => { errorEl.textContent = ''; errorEl.style.color = ''; }, 2000);
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

async function closeShiftScope() {
  const errorEl = $('shiftFormError');
  errorEl.textContent = '';
  const name = currentShiftName();
  if (!name) { errorEl.textContent = 'Indica el nombre del turno.'; return; }
  let target;
  try { target = resolveScope(); } catch (err) { errorEl.textContent = err.message; return; }

  const who = target.kind === 'weekdays'
    ? (target.weekdays.length > 1 ? 'todos los días' : 'ese día de la semana, cada semana')
    : `${target.dates.length} día(s)`;
  if (!confirm(`¿Cerrar el turno "${name}" para ${who}?`)) return;

  try {
    if (target.kind === 'weekdays') {
      for (const dayOfWeek of target.weekdays) {
        const shift = state.shifts.find(s => s.name === name && s.day_of_week === dayOfWeek);
        if (shift) await fetch(`/api/shifts/${shift.id}`, { method: 'DELETE' });
      }
    } else {
      for (const date of target.dates) {
        await fetch('/api/closures', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantId: RESTAURANT_ID, date, shift: name }),
        });
      }
    }
    await loadAll();
    errorEl.style.color = 'var(--brand-dark)';
    errorEl.textContent = 'Turno cerrado.';
    setTimeout(() => { errorEl.textContent = ''; errorEl.style.color = ''; }, 2000);
  } catch (err) {
    errorEl.textContent = 'No se pudo cerrar el turno.';
  }
}

// --- Lista de excepciones próximas --------------------------------------------
function renderOverridesList() {
  const box = $('overridesList');
  if (!state.overrides.length) {
    box.innerHTML = '<p class="cfg-hint">No hay excepciones de horario en los próximos 60 días.</p>';
    return;
  }
  box.innerHTML = state.overrides.map(o => `
    <div class="override-row">
      <span class="ov-date">${o.date}</span>
      <span class="ov-meta">${escapeHtml(o.shift_name)} · ${o.start_time}–${o.end_time}</span>
      <button type="button" data-id="${o.id}">Quitar</button>
    </div>
  `).join('');
  box.querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
    await fetch(`/api/shift-date-overrides/${b.dataset.id}`, { method: 'DELETE' });
    await loadAll();
  }));
}

window.addEventListener('DOMContentLoaded', async () => {
  if (!(await guardAdminPage())) return;
  renderSessionBar($('sessionBar'));

  populateHourSelect($('shiftStart'));
  populateHourSelect($('shiftEnd'));
  $('shiftStart').value = '13:00';
  $('shiftEnd').value = '16:00';

  const res = await fetch(`/api/restaurants/${RESTAURANT_ID}`);
  const restaurant = await res.json();
  $('restaurantName').textContent = `Horarios — ${restaurant.name}`;

  await loadAll();
  renderScopeFields();

  $('shiftName').addEventListener('change', toggleNewShiftInput);
  document.querySelectorAll('input[name="scope"]').forEach(r => r.addEventListener('change', renderScopeFields));
  $('shiftForm').addEventListener('submit', applyHours);
  $('closeShiftScopeBtn').addEventListener('click', closeShiftScope);
});
