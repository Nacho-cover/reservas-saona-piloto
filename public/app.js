const RESTAURANT_ID = 1; // en producción: resuelto por subdominio / QR de mesa / selector de local

const state = {
  restaurant: null,
  date: null,
  partySize: null,
  selectedTime: null,
};

const $ = (id) => document.getElementById(id);

function showStep(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
  $(id).classList.remove('hidden');
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

async function loadRestaurant() {
  const res = await fetch(`/api/restaurants/${RESTAURANT_ID}`);
  const data = await res.json();
  state.restaurant = data;
  $('restaurantName').textContent = data.name;
  $('restaurantAddress').textContent = data.address || '';
  $('restaurantPhone').textContent = data.phone || '';

  const partySelect = $('partySizeInput');
  partySelect.innerHTML = '';
  for (let i = 1; i <= data.max_party_size; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = i === 1 ? '1 persona' : `${i} personas`;
    if (i === 2) opt.selected = true;
    partySelect.appendChild(opt);
  }
}

function initDateInput() {
  const input = $('dateInput');
  input.min = todayISO();
  input.value = todayISO();
}

async function searchAvailability() {
  $('searchError').textContent = '';
  const date = $('dateInput').value;
  const partySize = $('partySizeInput').value;
  if (!date) { $('searchError').textContent = 'Elige una fecha.'; return; }

  state.date = date;
  state.partySize = Number(partySize);

  const btn = $('searchBtn');
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  try {
    const res = await fetch(`/api/availability?restaurantId=${RESTAURANT_ID}&date=${date}&partySize=${partySize}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al consultar disponibilidad');
    renderSlots(data.slots);
  } catch (err) {
    $('searchError').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ver disponibilidad';
  }
}

function renderSlots(slots) {
  const dateFmt = new Date(state.date + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  $('slotsSummary').textContent = `${state.partySize} ${state.partySize === 1 ? 'persona' : 'personas'} · ${dateFmt}`;

  const groups = {};
  for (const s of slots) {
    if (!groups[s.shift]) groups[s.shift] = [];
    groups[s.shift].push(s);
  }

  const container = $('shiftGroups');
  container.innerHTML = '';
  const hasAny = slots.some(s => s.available);
  $('noSlotsMsg').classList.toggle('hidden', hasAny || slots.length === 0);
  if (slots.length === 0) $('noSlotsMsg').classList.remove('hidden');

  for (const [shiftName, shiftSlots] of Object.entries(groups)) {
    const group = document.createElement('div');
    group.className = 'shift-group';
    const h3 = document.createElement('h3');
    h3.textContent = shiftName;
    group.appendChild(h3);

    const grid = document.createElement('div');
    grid.className = 'slot-grid';
    for (const s of shiftSlots) {
      const btn = document.createElement('button');
      btn.className = 'slot-btn' + (s.available ? '' : ' unavailable');
      btn.textContent = s.time;
      btn.disabled = !s.available;
      btn.addEventListener('click', () => selectSlot(s.time, btn));
      grid.appendChild(btn);
    }
    group.appendChild(grid);
    container.appendChild(group);
  }

  showStep('step-slots');
}

function selectSlot(time, btnEl) {
  document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
  btnEl.classList.add('selected');
  state.selectedTime = time;
  goToForm();
}

function dateFmtLong() {
  return new Date(state.date + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}
function partyWord() {
  return `${state.partySize} ${state.partySize === 1 ? 'persona' : 'personas'}`;
}

// La mesa la asigna el restaurante automáticamente al confirmar (ver POST
// /api/reservations sin tableIds) — el cliente no elige mesa.
function goToForm() {
  $('formSummary').innerHTML = '';
  const chip = document.createElement('div');
  chip.className = 'recap-chip';
  chip.innerHTML = `
    <div class="recap-ic">🕐</div>
    <div class="recap-txt"><b>${dateFmtLong()}</b><br>${state.selectedTime}h · ${partyWord()}</div>
  `;
  $('formSummary').appendChild(chip);
  showStep('step-form');
}

async function confirmReservation() {
  $('formError').textContent = '';
  const customerName = $('nameInput').value.trim();
  const phone = $('phoneInput').value.trim();
  const email = $('emailInput').value.trim();
  const notes = $('notesInput').value.trim();

  const consentAccepted = $('consentInput').checked;

  if (!customerName) { $('formError').textContent = 'Indica tu nombre.'; return; }
  if (!phone) { $('formError').textContent = 'Indica un teléfono de contacto.'; return; }
  if (!consentAccepted) { $('formError').textContent = 'Debes aceptar el tratamiento de datos para reservar.'; return; }

  const btn = $('confirmBtn');
  btn.disabled = true;
  btn.textContent = 'Confirmando…';
  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: RESTAURANT_ID,
        customerName, phone, email, notes,
        partySize: state.partySize,
        date: state.date,
        time: state.selectedTime,
        source: 'web',
        consentAccepted,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'No se pudo confirmar la reserva');
    }

    const dateFmt = new Date(state.date + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    const zoneLine = (data.zoneNames && data.zoneNames.length)
      ? `<br><span class="recap-zone">📍 ${data.zoneNames.join(', ')}</span>`
      : '';
    $('confirmBox').innerHTML = `
      <strong>${state.restaurant.name}</strong><br>
      ${dateFmt} · ${state.selectedTime}h<br>
      ${state.partySize} ${state.partySize === 1 ? 'persona' : 'personas'}<br>
      Mesa: ${data.tables.join(', ')}${zoneLine}<br>
      A nombre de: ${customerName}
    `;
    showStep('step-confirm');
  } catch (err) {
    $('formError').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar reserva';
  }
}

function resetFlow() {
  $('nameInput').value = '';
  $('phoneInput').value = '';
  $('emailInput').value = '';
  $('notesInput').value = '';
  $('consentInput').checked = false;
  state.selectedTime = null;
  showStep('step-search');
}

window.addEventListener('DOMContentLoaded', async () => {
  initDateInput();
  await loadRestaurant();
  $('searchBtn').addEventListener('click', searchAvailability);
  $('backToSearch').addEventListener('click', () => showStep('step-search'));
  $('backToSlots').addEventListener('click', () => showStep('step-slots'));
  $('confirmBtn').addEventListener('click', confirmReservation);
  $('newReservationBtn').addEventListener('click', resetFlow);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
