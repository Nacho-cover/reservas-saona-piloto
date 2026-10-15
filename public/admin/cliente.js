// Ficha de cliente del panel de reservas (ver server/customers.js): avisos junto a cada
// reserva (VIP, Lista negra, no-shows, alergias), ventana con la ficha completa y
// reconocimiento del cliente al apuntar una reserva por teléfono.
// Usa escapeHtml(), hasPerm() y RESTAURANT_ID de admin.js / authbar.js.

const CUST = { meta: null, card: null, onChange: null };

async function custMeta() {
  if (CUST.meta) return CUST.meta;
  const res = await fetch('/api/customers/meta');
  CUST.meta = res.ok ? await res.json() : { tags: [], allergens: [], canEditTags: false };
  return CUST.meta;
}
const CUST_TAG_LABELS = { vip: 'VIP', blacklist: 'Lista negra', no_paga: 'No paga', partner: 'Partner' };

// Chips compactos para una reserva. `c` = resumen que trae /api/reservations (r.customer).
function customerChips(c, { compact = false } = {}) {
  if (!c) return '';
  const chips = [];
  for (const t of c.tags || []) chips.push(`<span class="cchip cchip-${t}">${t === 'vip' ? '★ ' : t === 'blacklist' ? '⛔ ' : ''}${escapeHtml(CUST_TAG_LABELS[t] || t)}</span>`);
  if (c.noShows) chips.push(`<span class="cchip cchip-noshow" title="No se presentó a ${c.noShows} reserva${c.noShows === 1 ? '' : 's'} (en cualquier local del grupo)">⚠ ${c.noShows} no-show${c.noShows === 1 ? '' : 's'}</span>`);
  if ((c.allergies || []).length) {
    chips.push(`<span class="cchip cchip-allergy" title="Alergias: ${escapeHtml(c.allergies.join(', '))}">⚕ ${compact ? 'Alergias' : escapeHtml(c.allergies.join(', '))}</span>`);
  }
  if (!compact && c.visits >= 2 && !(c.tags || []).length) chips.push(`<span class="cchip cchip-regular">${c.visits} visitas</span>`);
  if (c.hasNotes) chips.push('<span class="cchip cchip-note" title="Tiene notas en la ficha">📝</span>');
  return chips.length ? `<span class="cchips">${chips.join('')}</span>` : '';
}

function custStatusLabel(h) {
  const base = (typeof STATUS_LABELS !== 'undefined' && STATUS_LABELS[h.status]) || h.status;
  if (h.status === 'cancelled') return base + (h.cancelledBy === 'customer' ? ' (cliente)' : h.cancelledBy === 'restaurant' ? ' (restaurante)' : '');
  return base;
}
function custDate(d) {
  if (!d) return '—';
  const [y, m, dd] = d.split('-');
  return `${dd}/${m}/${y}`;
}

async function openCustomerCard(phone, onChange) {
  if (!phone) return;
  CUST.onChange = onChange || null;
  const box = $('custSheet');
  box.innerHTML = '<p class="muted-small">Cargando ficha…</p>';
  $('custBackdrop').classList.remove('hidden');
  const [meta, res] = await Promise.all([custMeta(), fetch(`/api/customers/profile?phone=${encodeURIComponent(phone)}&restaurantId=${RESTAURANT_ID}`)]);
  const data = await res.json();
  if (!res.ok) { box.innerHTML = `<p class="error">${escapeHtml(data.error || 'No se pudo cargar la ficha')}</p><div class="modal-actions"><button class="btn btn-secondary" onclick="closeCustomerCard()">Cerrar</button></div>`; return; }
  CUST.card = data;
  CUST.phone = phone;
  renderCustomerCard(meta);
}

function renderCustomerCard(meta) {
  const c = CUST.card;
  const box = $('custSheet');
  const canTags = c.canEditTags;
  const st = c.stats;
  const webMsg = c.web.blocked
    ? `<div class="cust-alert">⛔ <b>No puede reservar por la web</b> — ${c.web.reason === 'blacklist' ? 'está en Lista negra' : 'tiene un no-show'}. Por teléfono sí se le puede apuntar.
        ${canTags && c.web.reason === 'no_show' ? '<button class="btn btn-secondary btn-sm" id="custUnblock">Desbloquear reserva web</button>' : ''}</div>`
    : (c.web.unblockedAt ? `<div class="cust-ok">Reserva web desbloqueada el ${escapeHtml(custDate(c.web.unblockedAt.slice(0, 10)))}.</div>` : '');

  const tagsHtml = meta.tags.map(t => `
    <label class="cust-toggle ${c.tags.includes(t.id) ? 'on' : ''} cchip-${t.id}-t">
      <input type="checkbox" data-tag="${t.id}" ${c.tags.includes(t.id) ? 'checked' : ''} ${canTags ? '' : 'disabled'}> ${escapeHtml(t.label)}
    </label>`).join('');
  const allergyHtml = meta.allergens.map(a => `
    <label class="cust-toggle ${c.allergies.includes(a) ? 'on allergy' : ''}">
      <input type="checkbox" data-allergy="${escapeHtml(a)}" ${c.allergies.includes(a) ? 'checked' : ''}> ${escapeHtml(a)}
    </label>`).join('');

  const hist = c.history.length ? `<table class="cust-hist">
      <thead><tr><th>Fecha</th><th>Local</th><th>Pax</th><th>Estado</th></tr></thead>
      <tbody>${c.history.map(h => `<tr class="${h.status === 'no_show' ? 'h-noshow' : ''}">
        <td>${escapeHtml(custDate(h.date))} ${escapeHtml(h.time)}</td>
        <td>${escapeHtml(h.restaurant)}</td><td>${h.partySize}</td><td>${escapeHtml(custStatusLabel(h))}</td></tr>`).join('')}</tbody>
    </table>` : '<p class="muted-small">Sin reservas en tus locales.</p>';

  box.innerHTML = `
    <h2 style="margin-bottom:2px">${escapeHtml(c.name || 'Cliente')}</h2>
    <p class="ts-sub">${escapeHtml(CUST.phone)}${c.email ? ' · ' + escapeHtml(c.email) : ''}</p>
    ${webMsg}
    <div class="cust-stats">
      <div><b>${st.visits}</b><span>visitas</span></div>
      <div class="${st.noShows ? 'bad' : ''}"><b>${st.noShows}</b><span>no-shows</span></div>
      <div><b>${st.cancelledByCustomer}</b><span>cancela él</span></div>
      <div><b>${escapeHtml(custDate(st.lastVisit))}</b><span>última visita</span></div>
    </div>
    <p class="muted-small" style="margin:4px 0 0">En todo el grupo${st.locales > 1 ? ` (${st.locales} locales)` : ''}. Primera visita: ${escapeHtml(custDate(st.firstVisit))}.</p>

    <div class="ts-section-title">Etiquetas${canTags ? '' : ' <small>(solo el Administrador las cambia)</small>'}</div>
    <div class="cust-toggles">${tagsHtml}</div>

    <div class="ts-section-title">Alergias e intolerancias</div>
    <div class="cust-toggles">${allergyHtml}</div>

    <div class="ts-section-title">Notas</div>
    <textarea id="custNotes" rows="2" maxlength="2000" placeholder="Preferencias, mesa favorita, celebraciones…">${escapeHtml(c.notes || '')}</textarea>

    <div class="ts-section-title">Historial${c.historyLimitedToYourLocales ? ' <small>(tus locales)</small>' : ''}</div>
    <div class="cust-hist-wrap">${hist}</div>

    <p class="error" id="custError"></p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="custCloseBtn">Cerrar</button>
      <button class="btn btn-primary" id="custSaveBtn">Guardar ficha</button>
    </div>`;

  box.querySelectorAll('.cust-toggle input').forEach(inp => inp.addEventListener('change', () => {
    inp.parentElement.classList.toggle('on', inp.checked);
    if (inp.dataset.allergy) inp.parentElement.classList.toggle('allergy', inp.checked);
  }));
  $('custCloseBtn').addEventListener('click', closeCustomerCard);
  $('custSaveBtn').addEventListener('click', saveCustomerCard);
  $('custUnblock')?.addEventListener('click', unblockCustomer);
}

async function saveCustomerCard() {
  const box = $('custSheet');
  const body = {
    phone: CUST.phone,
    restaurantId: RESTAURANT_ID,
    allergies: [...box.querySelectorAll('[data-allergy]:checked')].map(i => i.dataset.allergy),
    notes: $('custNotes').value,
  };
  if (CUST.card.canEditTags) body.tags = [...box.querySelectorAll('[data-tag]:checked')].map(i => i.dataset.tag);
  const btn = $('custSaveBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/customers/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo guardar');
    closeCustomerCard();
    if (CUST.onChange) CUST.onChange();
    if (typeof toast === 'function') toast('Ficha del cliente guardada');
  } catch (err) {
    $('custError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function unblockCustomer() {
  const res = await fetch('/api/customers/profile/unblock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: CUST.phone, restaurantId: RESTAURANT_ID }) });
  const data = await res.json();
  if (!res.ok) { $('custError').textContent = data.error || 'No se pudo desbloquear'; return; }
  CUST.card = data;
  renderCustomerCard(await custMeta());
  if (CUST.onChange) CUST.onChange();
}

function closeCustomerCard() {
  $('custBackdrop').classList.add('hidden');
}

// --- Nueva reserva por teléfono: reconocer al cliente al escribir el número -------------
let custLookupTimer = null;
let custLookupSeq = 0;
function watchPhoneForCustomer() {
  const input = $('mPhone');
  const out = $('mCustomerInfo');
  const run = async () => {
    const digits = input.value.replace(/[^0-9]/g, '');
    if (digits.length < 9) { out.innerHTML = ''; return; }
    const seq = ++custLookupSeq;
    const res = await fetch(`/api/customers/profile?phone=${encodeURIComponent(input.value)}&restaurantId=${RESTAURANT_ID}`);
    if (seq !== custLookupSeq) return;
    if (!res.ok) { out.innerHTML = ''; return; }
    const c = await res.json();
    if (!c.stats.reservations && !c.tags.length && !c.allergies.length) {
      out.innerHTML = '<span class="muted-small">Cliente nuevo.</span>';
      return;
    }
    // Rellena nombre y email si están vacíos.
    if (c.name && !$('mName').value.trim()) $('mName').value = c.name;
    if (c.email && !$('mEmail').value.trim()) $('mEmail').value = c.email;
    const summary = { tags: c.tags, allergies: c.allergies, noShows: c.stats.noShows, visits: c.stats.visits, hasNotes: !!c.notes };
    out.innerHTML = `${customerChips(summary)}
      <span class="muted-small">${c.stats.visits} visita${c.stats.visits === 1 ? '' : 's'} en el grupo${c.notes ? ' · ' + escapeHtml(c.notes.slice(0, 80)) : ''}</span>
      ${c.tags.includes('blacklist') ? '<div class="cust-alert" style="margin-top:6px">⛔ Cliente en Lista negra. Consulta con el encargado antes de confirmar.</div>' : ''}
      <button type="button" class="btn-link" id="mCustOpen">Ver ficha</button>`;
    $('mCustOpen').addEventListener('click', () => openCustomerCard(input.value));
  };
  input.addEventListener('input', () => { clearTimeout(custLookupTimer); custLookupTimer = setTimeout(run, 400); });
}
