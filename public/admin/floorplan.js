// Plano visual compartido entre config.html (disposición de la sala) y admin/index.html
// (ocupación del día) — coloca cada mesa según su pos_x/pos_y (0-100%, guardado al
// sembrar los datos reales de Cover) en vez de una simple lista de texto.

// Elementos fijos de Sala Interior (muro/tabique arriba y la escalera en el centro),
// leídos a ojo de la captura del plano de Cover — coordenadas aproximadas en % del lienzo.
const SALA_INTERIOR_FEATURES = [
  { x: 32, y: 6.3, w: 18.7, h: 2.5, label: '' },
  { x: 49.3, y: 7.5, w: 1.4, h: 11, label: '' },
  { x: 29, y: 55, w: 6.5, h: 8, label: '🪜' },
  { x: 0.7, y: 55.6, w: 27.7, h: 0.9, label: '' },
  { x: 36.1, y: 55.6, w: 28.7, h: 0.9, label: '' },
  { x: 20.2, y: 80.8, w: 0.8, h: 10.4, label: '' },
  { x: 55.6, y: 80.8, w: 0.9, h: 10.4, label: '' },
];
const SALA_INTERIOR_ZONE_LABELS = [
  { x: 2, y: 3, label: 'Barra' },
  { x: 2, y: 22, label: 'Sala Interior' },
];
function renderFloorPlan(container, tables, opts = {}) {
  // opts.features: elementos fijos de la sala (escalera, muro, barra...) —
  // [{ x, y, w, h, label }], todo en % del lienzo. Pendiente de coordenadas reales.
  // opts.editable: si es true, las mesas se pueden arrastrar (llama a opts.onMove(table,
  // x, y) al soltar) y un clic simple (sin arrastrar) llama a opts.onClick(table).
  // Sin editable, opts.onClick(table) se llama al pinchar la mesa (panel de reservas).
  // opts.canDrag(table) + opts.onDrop(fromTable, toTable): en el panel de reservas, una
  // mesa con reserva se puede arrastrar y soltar sobre otra (mover o intercambiar).
  // opts.getInfo(table): texto corto (o array de líneas) que se pinta pegado a la mesa
  // con la reserva que tiene (hora, nombre, comensales).
  const { getClass, getInfo, features = [], zoneLabels = [], editable = false, onMove, onClick, canDrag, onDrop } = opts;
  container.innerHTML = '';
  const withPos = tables.filter(t => t.pos_x != null && t.pos_y != null);
  if (!withPos.length) {
    container.innerHTML = '<p class="cfg-hint">Ninguna mesa de este plano tiene posición guardada todavía.</p>';
    return;
  }
  const scroll = document.createElement('div');
  scroll.className = 'fp-scroll';
  const canvas = document.createElement('div');
  canvas.className = 'fp-canvas' + (editable ? ' fp-editable' : '');

  for (const f of features) {
    const el = document.createElement('div');
    el.className = 'fp-feature';
    el.style.left = f.x + '%';
    el.style.top = f.y + '%';
    el.style.width = f.w + '%';
    el.style.height = f.h + '%';
    el.textContent = f.label || '';
    canvas.appendChild(el);
  }

  for (const z of zoneLabels) {
    const el = document.createElement('div');
    el.className = 'fp-zone-label';
    el.style.left = z.x + '%';
    el.style.top = z.y + '%';
    el.textContent = z.label;
    canvas.appendChild(el);
  }

  for (const t of withPos) {
    const node = document.createElement('div');
    node.className = 'fp-table' + (getClass ? ' ' + getClass(t) : '');
    node.style.left = t.pos_x + '%';
    node.style.top = t.pos_y + '%';
    node.title = `${t.name} (${t.capacity_min}-${t.capacity_max}p)${t.zoneName ? ' · ' + t.zoneName : ''}`;
    const nameEl = document.createElement('span');
    nameEl.textContent = t.name;
    const capEl = document.createElement('span');
    capEl.className = 'fp-cap';
    capEl.textContent = `${t.capacity_min}-${t.capacity_max}`;
    node.appendChild(nameEl);
    node.appendChild(capEl);
    node.dataset.tableId = t.id;
    const info = getInfo ? getInfo(t) : null;
    if (info && info.length) {
      const tag = document.createElement('div');
      tag.className = 'fp-info';
      for (const line of [].concat(info)) {
        const l = document.createElement('div');
        l.textContent = line;
        tag.appendChild(l);
      }
      node.appendChild(tag);
      node.classList.add('fp-has-info');
      node.title += '\n' + [].concat(info).join('\n');
    }
    if (editable) attachDrag(node, canvas, t, { onMove, onClick });
    else if (onClick) {
      node.classList.add('fp-clickable');
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
      if (canDrag && onDrop && canDrag(t)) attachReservationDrag(node, t, withPos, onDrop);
      node.addEventListener('click', () => { if (node.dataset.justDragged) { delete node.dataset.justDragged; return; } onClick(t); });
      node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(t); } });
    }
    canvas.appendChild(node);
  }
  scroll.appendChild(canvas);
  container.appendChild(scroll);
}

// Arrastrar una mesa dentro del lienzo (ratón y táctil). Distingue un arrastre real
// de un simple clic (umbral de 4px) para poder abrir el editor con un toque.
function attachDrag(node, canvas, table, { onMove, onClick }) {
  let dragging = false;
  let startX, startY, moved;

  const onDown = (clientX, clientY) => {
    dragging = true;
    moved = false;
    startX = clientX;
    startY = clientY;
    node.classList.add('dragging');
  };

  const onMoveEvt = (clientX, clientY) => {
    if (!dragging) return;
    if (Math.abs(clientX - startX) > 4 || Math.abs(clientY - startY) > 4) moved = true;
    const rect = canvas.getBoundingClientRect();
    let x = ((clientX - rect.left) / rect.width) * 100;
    let y = ((clientY - rect.top) / rect.height) * 100;
    x = Math.max(0, Math.min(100, x));
    y = Math.max(0, Math.min(100, y));
    node.style.left = x + '%';
    node.style.top = y + '%';
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    node.classList.remove('dragging');
    if (moved) {
      const x = parseFloat(node.style.left);
      const y = parseFloat(node.style.top);
      if (onMove) onMove(table, Math.round(x * 10) / 10, Math.round(y * 10) / 10);
    } else if (onClick) {
      onClick(table);
    }
  };

  node.addEventListener('mousedown', (e) => { e.preventDefault(); onDown(e.clientX, e.clientY); });
  window.addEventListener('mousemove', (e) => onMoveEvt(e.clientX, e.clientY));
  window.addEventListener('mouseup', onUp);

  node.addEventListener('touchstart', (e) => { const t = e.touches[0]; onDown(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener('touchmove', (e) => { if (dragging) { const t = e.touches[0]; onMoveEvt(t.clientX, t.clientY); } }, { passive: true });
  window.addEventListener('touchend', onUp);
}

// Arrastrar una mesa CON RESERVA hasta otra mesa (panel de reservas): se mueve una
// copia de la mesa bajo el dedo/ratón y al soltar sobre otra mesa se llama a
// onDrop(origen, destino). Un toque sin arrastrar sigue abriendo la ficha (click).
function attachReservationDrag(node, table, tables, onDrop) {
  let start = null, ghost = null, hoverEl = null;
  const byId = new Map(tables.map(t => [String(t.id), t]));

  const targetAt = (x, y) => {
    if (ghost) ghost.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    if (ghost) ghost.style.display = '';
    const tEl = el && el.closest ? el.closest('.fp-table') : null;
    return tEl && tEl !== node ? tEl : null;
  };

  const onDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onMove = (e) => {
    if (!start || e.pointerId !== start.id) return;
    if (!ghost) {
      if (Math.abs(e.clientX - start.x) < 6 && Math.abs(e.clientY - start.y) < 6) return;
      ghost = node.cloneNode(true);
      ghost.classList.add('fp-ghost');
      const r = node.getBoundingClientRect();
      ghost.style.width = r.width + 'px';
      ghost.style.height = r.height + 'px';
      document.body.appendChild(ghost);
      node.classList.add('fp-drag-source');
      try { node.setPointerCapture(e.pointerId); } catch { /* sin captura: sigue funcionando */ }
    }
    e.preventDefault();
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
    const tEl = targetAt(e.clientX, e.clientY);
    if (tEl !== hoverEl) {
      if (hoverEl) hoverEl.classList.remove('fp-drop-hover');
      hoverEl = tEl;
      if (hoverEl) hoverEl.classList.add('fp-drop-hover');
    }
  };
  const finish = (e, cancelled) => {
    if (!start || (e && e.pointerId !== start.id)) return;
    const wasDragging = !!ghost;
    if (ghost) { ghost.remove(); ghost = null; }
    node.classList.remove('fp-drag-source');
    if (hoverEl) hoverEl.classList.remove('fp-drop-hover');
    const tEl = (!cancelled && wasDragging && e) ? targetAt(e.clientX, e.clientY) : null;
    hoverEl = null;
    start = null;
    if (wasDragging) {
      node.dataset.justDragged = '1';
      setTimeout(() => { delete node.dataset.justDragged; }, 400);
      const to = tEl && byId.get(tEl.dataset.tableId);
      if (to) onDrop(table, to);
    }
  };

  node.style.touchAction = 'none';
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', (e) => finish(e, false));
  node.addEventListener('pointercancel', (e) => finish(e, true));
}
