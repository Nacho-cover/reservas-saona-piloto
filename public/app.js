const RESTAURANT_KEY = 'saona_restaurant_id';
// Prioridad: ?restaurantId= en la URL (QR de mesa, enlace directo) > lo último
// elegido en el selector (localStorage) > 1 por defecto. En producción esto se
// podría resolver también por subdominio.
function resolveRestaurantId() {
  const fromUrl = Number(new URLSearchParams(location.search).get('restaurantId'));
  if (fromUrl) {
    localStorage.setItem(RESTAURANT_KEY, String(fromUrl));
    return fromUrl;
  }
  return Number(localStorage.getItem(RESTAURANT_KEY)) || 1;
}
const RESTAURANT_ID = resolveRestaurantId();

const state = {
  restaurant: null,
  date: null,
  partySize: null,
  selectedTime: null,
  zoneId: null,
  zoneName: null,
};

const $ = (id) => document.getElementById(id);
// Escapa texto antes de meterlo en HTML (nombres, mesas, zonas…): evita que un texto
// con etiquetas se ejecute como código en la página (auditoría 17/10, H-09).
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showStep(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
  $(id).classList.remove('hidden');
}

// Nunca usar Date.toISOString() aquí: convierte a UTC y con husos horarios por
// delante de UTC (como España) desplaza la fecha un día hacia atrás cerca de
// medianoche. Hay que formatear con los componentes de fecha locales.
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

// Solo se muestra si hay más de un local: con uno solo el selector no aporta
// nada. Cambiar de local recarga la página con ?restaurantId=... para que un
// enlace copiado (o recargar) mantenga el local elegido.
async function renderRestaurantBar() {
  const container = $('restaurantBar');
  if (!container) return;
  let restaurants = [];
  try {
    const res = await fetch('/api/restaurants');
    restaurants = res.ok ? await res.json() : [];
  } catch { /* si falla, se deja sin selector en vez de romper la página */ }
  if (restaurants.length <= 1) return;

  const select = document.createElement('select');
  select.id = 'restaurantSelect';
  select.className = 'restaurant-select';
  for (const r of restaurants) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.name;
    if (r.id === RESTAURANT_ID) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    location.href = `/?restaurantId=${select.value}`;
  });
  container.appendChild(select);
}

function initDateInput() {
  const input = $('dateInput');
  input.min = todayISO();
  input.value = todayISO();
}

// El plano (y por tanto qué zonas hay) puede variar según la fecha, igual que en
// Cover — se recarga el selector cada vez que cambia la fecha. Si solo hay una
// zona (o ninguna, planos sin zonas asignadas) no tiene sentido elegir: se oculta
// el campo entero en vez de mostrar un desplegable con una sola opción.
async function loadZonesForDate(date) {
  const select = $('zoneInput');
  const field = $('zoneField');
  try {
    const res = await fetch(`/api/zones-for-date?restaurantId=${RESTAURANT_ID}&date=${date}`);
    const zones = res.ok ? await res.json() : [];
    select.innerHTML = '<option value="">Cualquiera</option>';
    for (const z of zones) {
      const opt = document.createElement('option');
      opt.value = z.id;
      opt.textContent = z.name;
      select.appendChild(opt);
    }
    field.classList.toggle('hidden', zones.length < 2);
  } catch {
    field.classList.add('hidden');
  }
}

async function searchAvailability() {
  $('searchError').textContent = '';
  const date = $('dateInput').value;
  const partySize = $('partySizeInput').value;
  if (!date) { $('searchError').textContent = 'Elige una fecha.'; return; }

  state.date = date;
  state.partySize = Number(partySize);
  const zoneSelect = $('zoneInput');
  state.zoneId = zoneSelect.value || null;
  state.zoneName = state.zoneId ? zoneSelect.options[zoneSelect.selectedIndex].textContent : null;

  const btn = $('searchBtn');
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  try {
    const zoneParam = state.zoneId ? `&zoneId=${state.zoneId}` : '';
    const res = await fetch(`/api/availability?restaurantId=${RESTAURANT_ID}&date=${date}&partySize=${partySize}${zoneParam}`);
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

  state.slots = slots;
  const container = $('shiftGroups');
  container.innerHTML = '';
  const hasAny = slots.some(s => s.available);
  // Lista de espera: si alguna hora está completa (y el día tiene horas), se ofrece.
  $('waitlistCta').classList.toggle('hidden', !slots.some(s => !s.available));
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
      if (!s.available) btn.title = 'Completo: toca para apuntarte a la lista de espera';
      btn.addEventListener('click', () => (s.available ? selectSlot(s.time, btn) : openWaitlist(s.time)));
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

// La mesa concreta la asigna el restaurante automáticamente al confirmar (ver POST
// /api/reservations sin tableIds) — el cliente no elige mesa, pero si eligió zona
// (ver zoneInput) la asignación se restringe a esa zona.
function eurosTxt(cents) {
  const n = cents / 100;
  return n.toLocaleString('es-ES', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }) + ' €';
}

// Locales con garantía activada: se explica la política y se pide aceptarla antes de ir
// a la pasarela de Redsys (no se cobra nada al reservar).
function renderGuarantee() {
  const r = state.restaurant || {};
  const on = !!r.guarantee_enabled;
  $('guaranteeBox').classList.toggle('hidden', !on);
  $('confirmBtn').textContent = on ? 'Continuar y dejar tarjeta' : 'Confirmar reserva';
  if (!on) return;
  const per = r.guarantee_fee_cents || 0;
  const total = per * (state.partySize || 1);
  const h = r.guarantee_free_cancel_hours || 0;
  $('guaranteeText').innerHTML = `Para confirmar la reserva te pediremos una tarjeta en la pasarela segura de nuestro banco. <b>No se cobra nada ahora.</b>
    Si no puedes venir, avísanos con al menos <b>${h} h</b> de antelación. Si no te presentas o cancelas más tarde, se cobrarán
    <b>${eurosTxt(per)} por persona</b> (${eurosTxt(total)} en total).`;
}

function goToForm() {
  renderGuarantee();
  $('formSummary').innerHTML = '';
  const chip = document.createElement('div');
  chip.className = 'recap-chip';
  const zoneLine = state.zoneName ? `<br>${esc(state.zoneName)}` : '';
  chip.innerHTML = `
    <div class="recap-ic">🕐</div>
    <div class="recap-txt"><b>${dateFmtLong()}</b><br>${state.selectedTime}h · ${partyWord()}${zoneLine}</div>
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
  const needsCard = !!(state.restaurant && state.restaurant.guarantee_enabled);
  if (needsCard && !$('policyInput').checked) { $('formError').textContent = 'Debes aceptar la política de cancelación para reservar.'; return; }

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
        zoneId: state.zoneId,
        source: 'web',
        consentAccepted,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'No se pudo confirmar la reserva');
    }

    // Garantía con tarjeta: la reserva queda apartada y el cliente va a la pasarela.
    if (data.redsys) {
      goToRedsys(data.redsys);
      return;
    }

    const dateFmt = new Date(state.date + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    const zoneLine = (data.zoneNames && data.zoneNames.length)
      ? `<br><span class="recap-zone">📍 ${esc(data.zoneNames.join(', '))}</span>`
      : '';
    $('confirmBox').innerHTML = `
      <strong>${esc(state.restaurant.name)}</strong><br>
      ${dateFmt} · ${esc(state.selectedTime)}h<br>
      ${state.partySize} ${state.partySize === 1 ? 'persona' : 'personas'}<br>
      Mesa: ${esc(data.tables.join(', '))}${zoneLine}<br>
      A nombre de: ${esc(customerName)}
    `;
    showStep('step-confirm');
  } catch (err) {
    $('formError').textContent = err.message;
  } finally {
    if (!state.redirecting) {
      btn.disabled = false;
      btn.textContent = state.restaurant && state.restaurant.guarantee_enabled ? 'Continuar y dejar tarjeta' : 'Confirmar reserva';
    }
  }
}

function goToRedsys({ url, fields }, formId = 'redsysForm') {
  state.redirecting = true;
  if (formId === 'redsysForm') {
    $('confirmBtn').textContent = 'Abriendo la pasarela segura…';
    $('formError').innerHTML = '<span class="redirect-note">Te llevamos a la pasarela de pago del banco. Tienes 20 minutos para completarla; después la mesa se libera.</span>';
  } else {
    $('offerAcceptBtn').textContent = 'Abriendo la pasarela segura…';
  }
  const form = $(formId);
  form.action = url;
  form.innerHTML = '';
  for (const [k, v] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden'; input.name = k; input.value = v;
    form.appendChild(input);
  }
  form.submit();
}

function showConfirmation(d) {
  const dateFmt = new Date(d.date + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const zoneLine = (d.zoneNames && d.zoneNames.length) ? `<br><span class="recap-zone">📍 ${esc(d.zoneNames.join(', '))}</span>` : '';
  const card = d.guarantee_status === 'ok'
    ? `<br>💳 Garantizada con tu tarjeta${d.card_last4 ? ' ···' + esc(d.card_last4) : ''} (no se ha cobrado nada)` : '';
  $('confirmBox').innerHTML = `
    <strong>${esc(d.restaurant_name || (state.restaurant && state.restaurant.name) || '')}</strong><br>
    ${dateFmt} · ${esc(d.time)}h<br>
    ${Number(d.party_size)} ${d.party_size === 1 ? 'persona' : 'personas'}<br>
    Mesa: ${esc((d.tables || []).join(', '))}${zoneLine}<br>
    A nombre de: ${esc(d.customer_name)}${card}
  `;
  showStep('step-confirm');
}

// Vuelta desde la pasarela de Redsys: /?reserva=ID&k=CLAVE&pago=ok|ko
async function handleRedsysReturn() {
  const q = new URLSearchParams(location.search);
  if (!q.get('reserva') || !q.get('k')) return false;
  const id = q.get('reserva'); const k = q.get('k'); const pago = q.get('pago');
  history.replaceState(null, '', location.pathname + (q.get('restaurantId') ? '?restaurantId=' + q.get('restaurantId') : ''));
  for (let i = 0; i < 8; i++) {
    const res = await fetch(`/api/public/reservations/${encodeURIComponent(id)}?k=${encodeURIComponent(k)}`);
    if (res.ok) {
      const d = await res.json();
      if (d.status !== 'pending_card') { showConfirmation(d); return true; }
      if (pago === 'ko') break;
    } else break;
    await new Promise(r => setTimeout(r, 1500)); // la notificación del banco puede tardar unos segundos
  }
  showStep('step-card-failed');
  return true;
}

// --- Lista de espera ---------------------------------------------------------------
function openWaitlist(time) {
  const sel = $('wlTime');
  sel.innerHTML = '';
  for (const s of (state.slots || []).filter(x => !x.available)) {
    const o = document.createElement('option');
    o.value = s.time; o.textContent = `${s.time} (${s.shift.toLowerCase()})`;
    sel.appendChild(o);
  }
  if (time) sel.value = time;
  else { const firstFull = (state.slots || []).find(s => !s.available); if (firstFull) sel.value = firstFull.time; }
  $('wlSummary').textContent = `${partyWord()} · ${dateFmtLong()}. Si se libera una mesa a esa hora te avisamos y tendrás unos minutos para confirmarla.`;
  for (const [from, to] of [['nameInput', 'wlName'], ['phoneInput', 'wlPhone'], ['emailInput', 'wlEmail']]) if (!$(to).value) $(to).value = $(from).value;
  $('wlError').textContent = '';
  showStep('step-waitlist');
}

async function submitWaitlist() {
  $('wlError').textContent = '';
  const body = {
    restaurantId: RESTAURANT_ID, date: state.date, time: $('wlTime').value, partySize: state.partySize,
    customerName: $('wlName').value.trim(), phone: $('wlPhone').value.trim(), email: $('wlEmail').value.trim(),
    consentAccepted: $('wlConsent').checked,
  };
  if (!body.customerName) { $('wlError').textContent = 'Indica tu nombre.'; return; }
  if (!body.phone) { $('wlError').textContent = 'Indica un teléfono: te avisaremos por WhatsApp.'; return; }
  if (!body.consentAccepted) { $('wlError').textContent = 'Debes aceptar el tratamiento de datos.'; return; }
  const btn = $('wlSubmitBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo apuntar a la lista');
    $('wlOkText').textContent = `${dateFmtLong()} · ${body.time}h · ${partyWord()}. Si se libera una mesa te avisaremos por ${data.channel === 'email' ? 'email' : 'WhatsApp'} al momento, y tendrás unos minutos para confirmarla.`;
    showStep('step-waitlist-ok');
  } catch (err) {
    $('wlError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function showMessage(title, text, icon = 'ℹ') {
  $('msgTitle').textContent = title;
  $('msgText').textContent = text;
  $('msgIcon').textContent = icon;
  showStep('step-message');
}

// Oferta de mesa (enlace /l/... del aviso): /?lista=ID&k=CLAVE
let offerTimer = null;
async function handleWaitlistOffer() {
  const q = new URLSearchParams(location.search);
  if (!q.get('lista') || !q.get('k')) return false;
  const id = q.get('lista'); const k = q.get('k');
  history.replaceState(null, '', location.pathname + (q.get('restaurantId') ? '?restaurantId=' + q.get('restaurantId') : ''));
  const res = await fetch(`/api/public/waitlist/${encodeURIComponent(id)}?k=${encodeURIComponent(k)}`);
  if (!res.ok) { showMessage('Enlace no válido', 'Este enlace de la lista de espera no es válido.', '!'); return true; }
  const w = await res.json();
  if (w.status === 'accepted') { showMessage('Mesa ya confirmada', 'Ya confirmaste esta mesa. ¡Te esperamos!', '✓'); return true; }
  if (w.status !== 'offered') {
    showMessage('La oferta ha caducado', `Lo sentimos, el tiempo para confirmar la mesa se ha agotado y se ha ofrecido a la siguiente persona. ${w.status === 'expired' ? 'Puedes volver a apuntarte o llamarnos' + (w.restaurant.phone ? ' al ' + w.restaurant.phone : '') + '.' : ''}`, '⌛');
    return true;
  }
  state.restaurant = { ...(state.restaurant || {}), ...w.restaurant };
  state.partySize = w.partySize;
  const dateFmt = new Date(w.date + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  $('offerBox').innerHTML = `<strong>${esc(w.restaurant.name)}</strong><br>${dateFmt} · ${esc(w.offerTime)}h<br>${Number(w.partySize)} ${w.partySize === 1 ? 'persona' : 'personas'}<br>A nombre de: ${esc(w.customerName)}`;
  const g = w.restaurant.guarantee_enabled;
  $('offerGuarantee').classList.toggle('hidden', !g);
  if (g) {
    const per = w.restaurant.guarantee_fee_cents || 0;
    $('offerGuaranteeText').innerHTML = `Para confirmar te pediremos una tarjeta en la pasarela segura del banco. <b>No se cobra nada ahora.</b> Si no vienes o cancelas con menos de <b>${w.restaurant.guarantee_free_cancel_hours} h</b>, se cobrarán <b>${eurosTxt(per)} por persona</b> (${eurosTxt(per * w.partySize)} en total).`;
    $('offerAcceptBtn').textContent = 'Confirmar y dejar tarjeta';
  }
  // Cuenta atrás con la hora del servidor (España), no la del móvil.
  const offset = Date.now() - new Date(w.nowMadrid.replace(' ', 'T') + 'Z').getTime();
  const expires = new Date(w.offerExpiresAt.replace(' ', 'T') + 'Z').getTime() + offset;
  clearInterval(offerTimer);
  const tick = () => {
    const left = Math.max(0, expires - Date.now());
    const m = Math.floor(left / 60000); const sec = Math.floor((left % 60000) / 1000);
    $('offerTimer').textContent = left > 0 ? `Tienes ${m}:${String(sec).padStart(2, '0')} min para confirmarla` : 'El tiempo para confirmar se ha agotado';
    $('offerAcceptBtn').disabled = left <= 0;
    if (left <= 0) clearInterval(offerTimer);
  };
  tick(); offerTimer = setInterval(tick, 1000);

  $('offerAcceptBtn').onclick = async () => {
    $('offerError').textContent = '';
    if (g && !$('offerPolicy').checked) { $('offerError').textContent = 'Debes aceptar la política de cancelación.'; return; }
    $('offerAcceptBtn').disabled = true;
    try {
      const r = await fetch('/api/reservations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        restaurantId: w.restaurant.id, customerName: w.customerName, phone: w.phone, email: w.email,
        partySize: w.partySize, date: w.date, time: w.offerTime, source: 'web', consentAccepted: true,
        waitlistId: w.id, waitlistKey: k,
      }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'No se pudo confirmar la mesa');
      clearInterval(offerTimer);
      if (data.redsys) { goToRedsys(data.redsys, 'redsysForm2'); return; }
      showConfirmation({ ...data, restaurant_name: w.restaurant.name, customer_name: w.customerName });
    } catch (err) {
      $('offerError').textContent = err.message.includes('email') ? 'Para confirmar online necesitamos tu email. Llámanos y te la apuntamos.' : err.message;
      $('offerAcceptBtn').disabled = false;
    }
  };
  $('offerLeaveBtn').onclick = async () => {
    if (!confirm('¿Quitarte de la lista de espera?')) return;
    await fetch(`/api/public/waitlist/${encodeURIComponent(id)}/leave`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k }) });
    clearInterval(offerTimer);
    showMessage('Te hemos quitado de la lista', 'Gracias por avisarnos. ¡Esperamos verte pronto!', '✓');
  };
  showStep('step-offer');
  return true;
}

// Gestionar la reserva (enlace /r/... del recordatorio): /?gestion=ID&k=CLAVE
async function handleManage() {
  const q = new URLSearchParams(location.search);
  if (!q.get('gestion') || !q.get('k')) return false;
  const id = q.get('gestion'); const k = q.get('k');
  history.replaceState(null, '', location.pathname + (q.get('restaurantId') ? '?restaurantId=' + q.get('restaurantId') : ''));
  const res = await fetch(`/api/public/manage/${encodeURIComponent(id)}?k=${encodeURIComponent(k)}`);
  if (!res.ok) { showMessage('Enlace no válido', 'No encontramos esta reserva.', '!'); return true; }
  const render = (d) => {
    const dateFmt = new Date(d.date + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    const st = d.status === 'cancelled' ? '<br><b style="color:var(--danger)">Reserva cancelada</b>'
      : (d.customer_confirmed_at ? '<br><b style="color:#1e7a34">✓ Asistencia confirmada</b>' : '');
    $('manageBox').innerHTML = `<strong>${esc(d.restaurant_name)}</strong><br>${dateFmt} · ${esc(d.time)}h<br>${Number(d.party_size)} ${d.party_size === 1 ? 'persona' : 'personas'}<br>A nombre de: ${esc(d.customer_name)}${st}`;
    $('manageActions').classList.toggle('hidden', !d.canChange);
    $('manageConfirmBtn').classList.toggle('hidden', !!d.customer_confirmed_at);
    $('manageNote').textContent = d.canChange
      ? (d.lateCancelPenaltyCents ? `Atención: quedan menos de ${d.freeCancelHours} h para la reserva; si cancelas ahora se podrá cobrar la penalización de ${eurosTxt(d.lateCancelPenaltyCents)}.` : 'Si no puedes venir, cancela para que otra persona pueda disfrutar de la mesa.')
      : (d.status === 'cancelled' ? '' : `Para cualquier cambio, llámanos${d.restaurant_phone ? ' al ' + d.restaurant_phone : ''}.`);
  };
  render(await res.json());
  const call = async (action) => {
    $('manageError').textContent = '';
    const r = await fetch(`/api/public/manage/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k }) });
    const d = await r.json();
    if (!r.ok) { $('manageError').textContent = d.error || 'No se pudo completar'; return; }
    render(d);
  };
  $('manageConfirmBtn').onclick = () => call('confirm');
  $('manageCancelBtn').onclick = () => { if (confirm('¿Seguro que quieres cancelar la reserva?')) call('cancel'); };
  showStep('step-manage');
  return true;
}

function resetFlow() {
  $('nameInput').value = '';
  $('phoneInput').value = '';
  $('emailInput').value = '';
  $('notesInput').value = '';
  $('consentInput').checked = false;
  $('policyInput').checked = false;
  state.selectedTime = null;
  state.redirecting = false;
  showStep('step-search');
}

window.addEventListener('DOMContentLoaded', async () => {
  initDateInput();
  await loadRestaurant();
  renderRestaurantBar();
  await loadZonesForDate($('dateInput').value);
  $('dateInput').addEventListener('change', (e) => { if (e.target.value) loadZonesForDate(e.target.value); });
  $('searchBtn').addEventListener('click', searchAvailability);
  $('backToSearch').addEventListener('click', () => showStep('step-search'));
  $('backToSlots').addEventListener('click', () => showStep('step-slots'));
  $('confirmBtn').addEventListener('click', confirmReservation);
  $('newReservationBtn').addEventListener('click', resetFlow);
  $('retryAfterCardBtn').addEventListener('click', resetFlow);
  $('openWaitlistBtn').addEventListener('click', () => openWaitlist(null));
  $('backToSlotsFromWl').addEventListener('click', () => showStep('step-slots'));
  $('wlSubmitBtn').addEventListener('click', submitWaitlist);
  $('wlDoneBtn').addEventListener('click', resetFlow);
  $('msgBtn').addEventListener('click', resetFlow);
  if (new URLSearchParams(location.search).get('enlace') === 'caducado') {
    history.replaceState(null, '', location.pathname);
    showMessage('Enlace no válido', 'Este enlace ya no es válido. Puedes hacer una reserva nueva o llamarnos.', '!');
  }
  await handleWaitlistOffer();
  await handleManage();
  $('partySizeInput').addEventListener('change', () => { if (!$('step-form').classList.contains('hidden')) renderGuarantee(); });
  await handleRedsysReturn();
  // Si el cliente vuelve atrás desde la pasarela, el botón se reactiva (la mesa sigue
  // apartada 20 min; si reintenta, se crea una reserva nueva y la anterior caduca).
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    state.redirecting = false;
    $('confirmBtn').disabled = false;
    renderGuarantee();
    $('formError').textContent = '';
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
