// Historial (hoja de vida) de una reserva: cada hecho, de principio a fin, con su hora,
// el canal y quién lo hizo. Los datos vienen de /api/trace/reservation/:id (ver
// server/trace.js). Usa escapeHtml() de admin.js.

function histTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const HIST_STATUS = {
  confirmed: 'Confirmada', pending_card: 'Pendiente de tarjeta o pago', seated: 'Sentada', eating: 'Comiendo', dessert: 'Postre',
  paid: 'Pagada', completed: 'Completada', cancelled: 'Cancelada', no_show: 'No show',
};
const HIST_PAGO = {
  ok: 'Tarjeta recibida', pending: 'Pendiente', paid: 'Pagado', charged: 'Cobrada', processing: 'En curso', failed: 'Rechazada',
  refunded: 'Devuelto', waiting: 'Esperando', offered: 'Oferta enviada', accepted: 'Aceptada', expired: 'Caducada',
  cancelled: 'Cancelada', sent: 'Enviado',
};
const HIST_AVISO = { reminder: 'Recordatorio del día antes', waitlist_offer: 'Oferta de mesa (lista de espera)' };
const HIST_CANAL = { whatsapp: 'WhatsApp', email: 'Email' };
const HIST_ESTADO_EVENTOS = ['creada', 'estado', 'cancelada', 'no_show', 'confirmada', 'reactivada', 'abandonada', 'eliminada'];

function histEuros(c) {
  return c == null ? '' : (Number(c) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2 }) + ' €';
}

function histDetail(e) {
  const d = e.details || {};
  const to = HIST_ESTADO_EVENTOS.includes(e.event) ? (HIST_STATUS[e.to] || e.to) : (HIST_PAGO[e.to] || e.to);
  switch (e.event) {
    case 'creada': return `${d.pax || ''} personas · ${d.fecha || ''} ${d.hora || ''}${d.turno ? ' · ' + d.turno : ''}`;
    case 'estado': return `${HIST_STATUS[e.from] || e.from || ''} → ${to || ''}`;
    case 'cancelada': return d.cancelado_por === 'customer' ? 'Cancela el cliente' : 'Cancela el restaurante';
    case 'modificada': return `${d.antes ? `${d.antes.pax} pax · ${d.antes.fecha} ${d.antes.hora}` : ''} → ${d.despues ? `${d.despues.pax} pax · ${d.despues.fecha} ${d.despues.hora}` : ''}`;
    case 'mesa_asignada': case 'mesa_liberada': return e.to ? `Mesa ${e.to}` : '';
    case 'aviso': return [HIST_AVISO[d.tipo] || d.tipo, HIST_CANAL[e.channel] || e.channel, to].filter(Boolean).join(' · ');
    case 'garantia': return [to, d.tarjeta ? `···${d.tarjeta}` : ''].filter(Boolean).join(' · ');
    case 'penalizacion': case 'pago_anticipado': case 'devolucion_pago': return [to, histEuros(d.importe_cent)].filter(Boolean).join(' · ');
    case 'abandonada': case 'eliminada': return `${d.pax || ''} personas · ${d.fecha || ''} ${d.hora || ''}`;
    case 'valoracion': return `General ${d.general}/5 · Comida ${d.comida}/5 · Servicio ${d.servicio}/5`;
    default: return to || '';
  }
}

function closeReservationTrace() {
  document.getElementById('histBackdrop')?.classList.add('hidden');
}

async function openReservationTrace(id) {
  let backdrop = document.getElementById('histBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop hidden';
    backdrop.id = 'histBackdrop';
    backdrop.innerHTML = '<div class="modal hist-modal" id="histSheet"></div>';
    backdrop.addEventListener('click', ev => { if (ev.target === backdrop) closeReservationTrace(); });
    document.body.appendChild(backdrop);
  }
  const box = document.getElementById('histSheet');
  box.innerHTML = '<p class="muted-small">Cargando historial…</p>';
  backdrop.classList.remove('hidden');
  let data;
  try {
    const res = await fetch(`/api/trace/reservation/${encodeURIComponent(id)}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo cargar el historial.');
  } catch (err) {
    box.innerHTML = `<p class="error">${escapeHtml(err.message)}</p><div class="modal-actions"><button class="btn btn-secondary" id="histClose">Cerrar</button></div>`;
    document.getElementById('histClose').addEventListener('click', closeReservationTrace);
    return;
  }
  const r = data.reservation;
  const head = r.eliminada
    ? `<h2>Reserva #${r.id}</h2><p class="muted-small">Esta reserva ya no existe (por ejemplo, caducó sin terminar el pago). Se conserva su rastro.</p>`
    : `<h2>Reserva #${r.id} · ${escapeHtml(r.nombre)}</h2>
       <p class="muted-small">${escapeHtml(r.local)} · ${r.pax} personas · ${escapeHtml(r.fecha)} ${escapeHtml(r.hora)}${r.turno ? ' · ' + escapeHtml(r.turno) : ''} · ${escapeHtml(HIST_STATUS[r.estado] || r.estado)}</p>`;
  const items = data.events.map(e => `
    <li class="hist-item">
      <div class="hist-when">${escapeHtml(histTime(e.at))}</div>
      <div class="hist-what"><strong>${escapeHtml(e.label)}</strong>${histDetail(e) ? `<span class="hist-detail">${escapeHtml(histDetail(e))}</span>` : ''}
        <span class="hist-by">${escapeHtml(e.by)}${e.reconstructed ? ' · reconstruido (anterior a la hoja de vida)' : ''}</span></div>
    </li>`).join('');
  box.innerHTML = `${head}
    <ol class="hist-list">${items || '<li class="hist-item"><div class="hist-what">Sin hechos registrados.</div></li>'}</ol>
    <div class="modal-actions"><button class="btn btn-secondary" id="histClose">Cerrar</button></div>`;
  document.getElementById('histClose').addEventListener('click', closeReservationTrace);
}
