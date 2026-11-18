// Pago anticipado (Redsys) en la pantalla Horarios: activarlo por local (links de pago desde
// el panel y/o pago automático en la web a partir de N comensales), importe por persona y
// horas de antelación para poder devolver el pago. El comercio de Redsys es el mismo de la
// garantía con tarjeta. Usa RESTAURANT_ID y $ de horarios.js, y applyPermissionVisibility de authbar.js.

function ppEuros(cents) {
  const n = (cents || 0) / 100;
  return n.toLocaleString('es-ES', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }) + ' €';
}

function ppRenderExample() {
  const fee = Math.round(Number($('ppFee').value || 0) * 100);
  const min = Number($('ppMinParty').value || 0);
  const h = Number($('ppHours').value || 0);
  $('ppExample').innerHTML = fee > 0
    ? `Ejemplo: un grupo de ${Math.max(min, 4)} personas paga <b>${ppEuros(fee * Math.max(min, 4))}</b>. Si cancela con al menos ${h} h de antelación (o cancela el restaurante) se le puede devolver; si cancela más tarde o no se presenta, no.`
    : '';
}

async function loadPrepay() {
  const res = await fetch(`/api/restaurants/${RESTAURANT_ID}/prepay`);
  if (!res.ok) { $('prepayCard').classList.add('hidden'); return; }
  const g = await res.json();
  $('ppEnabled').checked = g.enabled;
  $('ppWebEnabled').checked = g.webEnabled;
  $('ppFee').value = (g.feeCents / 100).toString();
  $('ppMinParty').value = g.minParty;
  $('ppHours').value = g.refundHours;
  const on = g.enabled || g.webEnabled;
  const st = $('ppState');
  st.textContent = on ? 'Activado' : 'Desactivado';
  st.classList.toggle('on', on);
  for (const id of ['ppEnabled', 'ppWebEnabled', 'ppFee', 'ppMinParty', 'ppHours']) $(id).disabled = !g.canEdit;
  ppRenderExample();
  const a = g.account;
  let info = '';
  if (a.configured) {
    info = `Comercio <b>${escapeHtml(a.merchantCode)}</b> · ${a.env === 'live'
      ? '<span class="g-badge-live">Real: cobra dinero</span>' : '<span class="g-badge-test">Pruebas: no mueve dinero</span>'}`;
  } else if (a.usingPublicTest) {
    info = '<span class="g-badge-test">Pruebas</span> Este local usa el comercio de pruebas de Redsys: no se cobra dinero real.';
  } else {
    info = '<span class="error">Sin comercio de Redsys: no se puede activar hasta configurarlo en «Garantía con tarjeta».</span>';
  }
  if (g.webEnabled && g.guaranteeEnabled) info += '<br>Las reservas web de grupos que pidan pago anticipado <b>no pedirán tarjeta de garantía</b>; el resto sí.';
  $('ppAccountInfo').innerHTML = info;
}

async function savePrepay(e) {
  e.preventDefault();
  $('ppError').textContent = '';
  const enabled = $('ppEnabled').checked;
  const webEnabled = $('ppWebEnabled').checked;
  if (webEnabled && !confirm(`Con el pago anticipado en la web, toda reserva de ${$('ppMinParty').value} o más personas tendrá que pagar antes de confirmarse. ¿Continuar?`)) return;
  const res = await fetch(`/api/restaurants/${RESTAURANT_ID}/prepay`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, webEnabled, feeEuros: Number($('ppFee').value), minParty: Number($('ppMinParty').value), refundHours: Number($('ppHours').value) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('ppError').textContent = data.error || 'No se pudo guardar'; return; }
  await loadPrepay();
}

function initPrepay() {
  $('ppForm').addEventListener('submit', savePrepay);
  for (const id of ['ppFee', 'ppMinParty', 'ppHours']) $(id).addEventListener('input', ppRenderExample);
  applyPermissionVisibility($('prepayCard'));
  loadPrepay();
}
