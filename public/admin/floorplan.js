// Plano visual compartido entre config.html (disposición de la sala) y admin/index.html
// (ocupación del día) — coloca cada mesa según su pos_x/pos_y (0-100%, guardado al
// sembrar los datos reales de Cover) en vez de una simple lista de texto.
function renderFloorPlan(container, tables, opts = {}) {
  const { getClass } = opts;
  container.innerHTML = '';
  const withPos = tables.filter(t => t.pos_x != null && t.pos_y != null);
  if (!withPos.length) {
    container.innerHTML = '<p class="cfg-hint">Ninguna mesa de este plano tiene posición guardada todavía.</p>';
    return;
  }
  const canvas = document.createElement('div');
  canvas.className = 'fp-canvas';
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
    canvas.appendChild(node);
  }
  container.appendChild(canvas);
}
