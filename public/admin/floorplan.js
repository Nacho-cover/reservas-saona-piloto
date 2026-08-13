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
  const { getClass, features = [], zoneLabels = [], editable = false, onMove, onClick } = opts;
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
    if (editable) attachDrag(node, canvas, t, { onMove, onClick });
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
