// Garantía con tarjeta (Redsys) en la pantalla Horarios: activarla por local, importe por
// persona y horas de cancelación gratuita (Administrador y Operaciones), y el comercio
// Redsys del local (solo Administrador). Usa RESTAURANT_ID y $ de horarios.js, hasPerm de authbar.js.

function gEuros(cents) {
  const n = (cents || 0) / 100;
  return n.toLocaleString('es-ES', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }) + ' €';
}

function gRenderExample() {
  const fee = Math.round(Number($('gFee').value || 0) * 100);
  const h = Number($('gHours').value || 0);
  $('gExample').innerHTML = fee > 0
    ? `Ejemplo: una reserva de 4 personas que no se presenta, o cancela con menos de ${h} h de antelación, puede cobrarse <b>${gEuros(fee * 4)}</b>.`
    : '';
}

async function loadGuarantee() {
  const res = await fetch(`/api/restaurants/${RESTAURANT_ID}/guarantee`);
  if (!res.ok) { $('guaranteeCard').classList.add('hidden'); return; }
  const g = await res.json();
  $('gEnabled').checked = g.enabled;
  $('gFee').value = (g.feeCents / 100).toString();
  $('gHours').value = g.freeCancelHours;
  const st = $('gState');
  st.textContent = g.enabled ? 'Activada' : 'Desactivada';
  st.classList.toggle('on', g.enabled);
  for (const id of ['gEnabled', 'gFee', 'gHours']) $(id).disabled = !g.canEdit;
  gRenderExample();

  const a = g.account;
  let info;
  if (a.configured) {
    info = `Comercio <b>${escapeHtml(a.merchantCode)}</b>, terminal ${escapeHtml(a.terminal)} · ${a.env === 'live'
      ? '<span class="g-badge-live">Real: cobra dinero</span>' : '<span class="g-badge-test">Pruebas: no mueve dinero</span>'}`;
    if (!a.usable) info += '<br><span class="error">No se puede usar: falta la variable PAYMENTS_SECRET en Render para leer la clave.</span>';
  } else if (a.usingPublicTest) {
    info = '<span class="g-badge-test">Pruebas</span> Este local no tiene comercio propio: se usa el <b>comercio de pruebas de Redsys</b> (tarjeta de prueba 4548 8100 0000 0003, caducidad 12/49, CVV 123). No se cobra dinero real.';
  } else {
    info = '<span class="error">Sin comercio de Redsys: no se puede activar la garantía hasta configurarlo.</span>';
  }
  if (g.canEditAccount && !a.canStoreSecrets) info += '<br>Para guardar la clave de un comercio hay que añadir antes la variable <b>PAYMENTS_SECRET</b> en Render.';
  $('gAccountInfo').innerHTML = info;
  if (g.canEditAccount) {
    $('gAccountForm').classList.remove('hidden');
    $('gFuc').value = a.merchantCode || '';
    $('gTerminal').value = a.terminal ? String(Number(a.terminal)) : '';
    $('gEnv').value = a.env || 'test';
    $('gSecret').value = '';
    $('gRemoveAccount').classList.toggle('hidden', !a.configured);
  }
}

async function saveGuarantee(e) {
  e.preventDefault();
  $('gError').textContent = '';
  const enabled = $('gEnabled').checked;
  if (enabled && !confirm('Con la garantía activada, todas las reservas web de este local pedirán tarjeta antes de confirmarse. ¿Continuar?')) return;
  const res = await fetch(`/api/restaurants/${RESTAURANT_ID}/guarantee`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, feeEuros: Number($('gFee').value), freeCancelHours: Number($('gHours').value) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('gError').textContent = data.error || 'No se pudo guardar'; return; }
  await loadGuarantee();
}

async function saveAccount(e) {
  e.preventDefault();
  $('gAccountError').textContent = '';
  const env = $('gEnv').value;
  if (env === 'live' && !confirm('En entorno REAL los cobros de penalización mueven dinero en la cuenta de este comercio. ¿Guardar?')) return;
  const res = await fetch(`/api/restaurants/${RESTAURANT_ID}/payment-account`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantCode: $('gFuc').value.trim(), terminal: $('gTerminal').value.trim(), env, secret: $('gSecret').value.trim() || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('gAccountError').textContent = data.error || 'No se pudo guardar'; return; }
  await loadGuarantee();
}

async function removeAccount() {
  if (!confirm('¿Quitar el comercio Redsys de este local? Volverá a usar el comercio de pruebas.')) return;
  const res = await fetch(`/api/restaurants/${RESTAURANT_ID}/payment-account`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remove: true }),
  });
  if (res.ok) await loadGuarantee();
}

function initGuarantee() {
  $('gForm').addEventListener('submit', saveGuarantee);
  $('gFee').addEventListener('input', gRenderExample);
  $('gHours').addEventListener('input', gRenderExample);
  $('gAccountForm').addEventListener('submit', saveAccount);
  $('gRemoveAccount').addEventListener('click', removeAccount);
  applyPermissionVisibility($('guaranteeCard'));
  loadGuarantee();
}
