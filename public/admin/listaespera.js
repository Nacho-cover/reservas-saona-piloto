// Lista de espera del día en el panel de reservas (ver server/waitlist.js), y avisos de
// recordatorio/confirmación del cliente en cada reserva. Usa $, state, escapeHtml,
// RESTAURANT_ID, toast y todayISO de admin.js.

const WL_STATUS = {
  waiting: 'Esperando', offered: 'Avisado', accepted: 'Aceptó la mesa', expired: 'No contestó a tiempo', cancelled: 'Quitado',
};
const WL_CHANNEL = { whatsapp: 'WhatsApp', email: 'Email', none: 'Sin enviar' };

function hhmm(stamp) { return stamp ? String(stamp).slice(11, 16) : ''; }

// Chips de la reserva: recordatorio enviado y asistencia confirmada por el cliente.
function reminderChips(r) {
  const chips = [];
  if (r.customer_confirmed_at) chips.push(`<span class="cchip cchip-confirmed" title="Confirmó desde el enlace del recordatorio">✓ Confirmó asistencia</span>`);
  else if (r.reminder_sent_at) chips.push(`<span class="cchip cchip-regular" title="Recordatorio enviado ${escapeHtml(r.reminder_sent_at)}">🔔 Recordatorio enviado</span>`);
  return chips.length ? `<span class="cchips">${chips.join('')}</span>` : '';
}

async function loadWaitlist() {
  const res = await fetch(`/api/waitlist-admin?restaurantId=${RESTAURANT_ID}&date=${state.date}`);
  if (!res.ok) return;
  const data = await res.json();
  state.waitlist = data.entries;
  const active = data.entries.filter(e => ['waiting', 'offered'].includes(e.status));
  $('wlCount').textContent = active.length ? `(${active.length})` : '';
  $('wlHint').textContent = `Al cancelarse una reserva se avisa solo al primero que encaje, por ${data.whatsapp ? 'WhatsApp' : 'email (WhatsApp aún no está configurado)'}; tiene ${data.offerMinutes} min para confirmar.`;
  const list = $('wlList');
  if (!data.entries.length) { list.innerHTML = '<div class="empty">Nadie en lista de espera este día.</div>'; return; }
  list.innerHTML = '';
  for (const e of data.entries) {
    const row = document.createElement('div');
    row.className = `wl-row wl-${e.status}`;
    const last = e.notifications[e.notifications.length - 1];
    const sent = last ? `${WL_CHANNEL[last.channel] || last.channel} ${hhmm(last.created_at)}${last.status === 'failed' ? ' (falló)' : ''}` : '';
    let status = WL_STATUS[e.status] || e.status;
    if (e.status === 'offered') status += ` · ${e.offer_time} · hasta las ${hhmm(e.offer_expires_at)}`;
    if (e.status === 'accepted' && e.reservation_id) status += ` · reserva #${e.reservation_id}`;
    row.innerHTML = `
      <div class="res-time">${escapeHtml(e.time)}</div>
      <div class="res-info">
        <div class="res-name">${escapeHtml(e.customer_name)} · ${e.party_size}p</div>
        <div class="res-meta">${escapeHtml(e.phone || '')}${e.notes ? ' · ' + escapeHtml(e.notes) : ''} · ${e.source === 'web' ? 'Web' : 'Panel'}</div>
        <span class="cchips"><span class="cchip wl-status">${escapeHtml(status)}</span>${sent ? `<span class="cchip cchip-regular">${escapeHtml(sent)}</span>` : ''}</span>
      </div>
      <div class="res-actions"></div>`;
    const actions = row.querySelector('.res-actions');
    if (['waiting', 'expired'].includes(e.status)) actions.appendChild(actionBtn('Avisar ahora', () => offerNow(e), 'btn-move'));
    if (['waiting', 'offered', 'expired'].includes(e.status)) actions.appendChild(actionBtn('Quitar', () => removeEntry(e), 'btn-cancel-restaurant'));
    list.appendChild(row);
  }
}

async function offerNow(e) {
  if (!confirm(`¿Avisar ahora a ${e.customer_name} de que hay mesa a las ${e.time}? Tendrá unos minutos para confirmarla.`)) return;
  const res = await fetch(`/api/waitlist-admin/${e.id}/offer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || 'No se pudo avisar'); return; }
  toast(`Aviso enviado por ${WL_CHANNEL[data.channel] || 'ningún canal'}.`);
  loadWaitlist();
}

async function removeEntry(e) {
  if (!confirm(`¿Quitar a ${e.customer_name} de la lista de espera?`)) return;
  await fetch(`/api/waitlist-admin/${e.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) });
  loadWaitlist();
}

async function fillWlTimes() {
  const sel = $('wlmTime');
  const date = $('wlmDate').value;
  sel.innerHTML = '';
  if (!date) return;
  const res = await fetch(`/api/shifts/slots?restaurantId=${RESTAURANT_ID}&date=${date}`);
  const data = res.ok ? await res.json() : { shifts: [] };
  for (const s of data.shifts) {
    const g = document.createElement('optgroup');
    g.label = s.name;
    for (const t of s.slots) { const o = document.createElement('option'); o.value = t; o.textContent = t; g.appendChild(o); }
    sel.appendChild(g);
  }
  if (!sel.options.length) sel.innerHTML = '<option value="">El local no abre ese día</option>';
}

function openWlModal() {
  for (const id of ['wlmName', 'wlmPhone', 'wlmEmail', 'wlmNotes']) $(id).value = '';
  $('wlmParty').value = 2;
  $('wlmDate').value = state.date;
  $('wlmError').textContent = '';
  fillWlTimes();
  $('wlBackdrop').classList.remove('hidden');
}

async function saveWl() {
  const body = {
    restaurantId: RESTAURANT_ID, customerName: $('wlmName').value.trim(), phone: $('wlmPhone').value.trim(),
    email: $('wlmEmail').value.trim(), date: $('wlmDate').value, time: $('wlmTime').value,
    partySize: Number($('wlmParty').value), notes: $('wlmNotes').value.trim(),
  };
  if (!body.customerName || !body.time) { $('wlmError').textContent = 'Indica el nombre y la hora.'; return; }
  if (!body.phone && !body.email) { $('wlmError').textContent = 'Hace falta un teléfono (WhatsApp) o un email para poder avisarle.'; return; }
  const res = await fetch('/api/waitlist-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('wlmError').textContent = data.error || 'No se pudo apuntar'; return; }
  $('wlBackdrop').classList.add('hidden');
  toast(`${body.customerName} apuntado a la lista de espera.`);
  if (body.date === state.date) loadWaitlist();
}

window.addEventListener('DOMContentLoaded', () => {
  $('wlAddBtn').addEventListener('click', openWlModal);
  $('wlmCancel').addEventListener('click', () => $('wlBackdrop').classList.add('hidden'));
  $('wlmSave').addEventListener('click', saveWl);
  $('wlmDate').addEventListener('change', fillWlTimes);
});
