// Exportación del plano de sala a PDF (admin/plano-pdf.html?floorPlanId=N).
// Dibuja el plano en SVG con la misma geometría que el editor de config.html
// (lienzo 1400x820, posiciones en % y mesas de 58px / 46px en barra), recortado
// al contenido para aprovechar la hoja, y añade una segunda hoja con el listado
// de mesas por zona y las combinaciones. El PDF lo genera el propio navegador
// («Imprimir → Guardar como PDF»), sin dependencias nuevas en el servidor.

const RESTAURANT_ID = getRestaurantId();
const params = new URLSearchParams(location.search);
const PLAN_ID = Number(params.get('floorPlanId')) || null;

const CANVAS_W = 1400, CANVAS_H = 820; // igual que .fp-canvas en floorplan.css
const TABLE_SIZE = 58, BAR_SIZE = 46;

// Colores por zona (relleno suave + borde), en el orden de las zonas del plano.
const ZONE_COLORS = [
  { fill: '#e8f0ea', stroke: '#1f4d3a' },
  { fill: '#e6eefc', stroke: '#2f5fbf' },
  { fill: '#fdf1dc', stroke: '#b07a12' },
  { fill: '#fbe7ef', stroke: '#b3476f' },
  { fill: '#efe9fb', stroke: '#6a4bb3' },
  { fill: '#e2f4f3', stroke: '#1f7f7a' },
];
const NO_ZONE = { fill: '#f2f2f2', stroke: '#777' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'es', { numeric: true });
const isBar = (zoneName) => /barra/i.test(zoneName || '');

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de red');
  return data;
}

function buildSvg(tables, zoneStyle, showPlazaFeatures) {
  const placed = tables.filter(t => t.pos_x != null && t.pos_y != null);
  if (!placed.length) return null;

  const items = placed.map(t => {
    const size = isBar(t.zoneName) ? BAR_SIZE : TABLE_SIZE;
    return { t, size, cx: (t.pos_x / 100) * CANVAS_W, cy: (t.pos_y / 100) * CANVAS_H };
  });

  // Recorta el lienzo al contenido (+ margen) para que el plano llene la hoja.
  const features = showPlazaFeatures ? SALA_INTERIOR_FEATURES : [];
  const labels = showPlazaFeatures ? SALA_INTERIOR_ZONE_LABELS : [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.cx - it.size / 2); maxX = Math.max(maxX, it.cx + it.size / 2);
    minY = Math.min(minY, it.cy - it.size / 2); maxY = Math.max(maxY, it.cy + it.size / 2);
  }
  for (const f of features) {
    minX = Math.min(minX, f.x / 100 * CANVAS_W); maxX = Math.max(maxX, (f.x + f.w) / 100 * CANVAS_W);
    minY = Math.min(minY, f.y / 100 * CANVAS_H); maxY = Math.max(maxY, (f.y + f.h) / 100 * CANVAS_H);
  }
  const pad = 30;
  const vx = minX - pad, vy = minY - pad, vw = (maxX - minX) + pad * 2, vh = (maxY - minY) + pad * 2;

  const parts = [];
  parts.push(`<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#fbfaf7" stroke="#e2e0da" stroke-width="1.5" rx="10"/>`);
  parts.push(`<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#d8d5cc"/><rect width="4" height="8" fill="#cfccc2"/></pattern></defs>`);

  for (const f of features) {
    const x = f.x / 100 * CANVAS_W, y = f.y / 100 * CANVAS_H, w = f.w / 100 * CANVAS_W, h = f.h / 100 * CANVAS_H;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#hatch)" stroke="#b8b4a8" rx="3"/>`);
    if (f.label) parts.push(`<text x="${x + w / 2}" y="${y + h / 2 + 6}" font-size="18" text-anchor="middle">${esc(f.label)}</text>`);
  }
  for (const l of labels) {
    parts.push(`<text x="${l.x / 100 * CANVAS_W + 8}" y="${l.y / 100 * CANVAS_H + 16}" font-size="14" font-weight="700" fill="#6b6b6b" letter-spacing="0.5">${esc(l.label.toUpperCase())}</text>`);
  }

  for (const { t, size, cx, cy } of items) {
    const st = zoneStyle(t.zoneName);
    const shape = isBar(t.zoneName)
      ? `<circle cx="${cx}" cy="${cy}" r="${size / 2}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="2.5"/>`
      : `<rect x="${cx - size / 2}" y="${cy - size / 2}" width="${size}" height="${size}" rx="9" fill="${st.fill}" stroke="${st.stroke}" stroke-width="2.5"/>`;
    const nameSize = String(t.name).length > 4 ? 12 : 16;
    const cap = `${t.capacity_min}-${t.capacity_max}`;
    parts.push(`<g>${shape}
      <text x="${cx}" y="${cy + (isBar(t.zoneName) ? 5 : 1)}" font-size="${nameSize}" font-weight="700" text-anchor="middle" fill="#1c1c1c">${esc(t.name)}</text>
      ${isBar(t.zoneName) ? '' : `<text x="${cx}" y="${cy + 17}" font-size="11.5" text-anchor="middle" fill="#555">${esc(cap)}</text>`}
    </g>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" role="img" aria-label="Plano de sala">${parts.join('')}</svg>`;
}

function render({ restaurant, plan, zones, tables, combos }) {
  const zoneIndex = new Map(zones.map((z, i) => [z.name, i]));
  const zoneStyle = (name) => zoneIndex.has(name) ? ZONE_COLORS[zoneIndex.get(name) % ZONE_COLORS.length] : NO_ZONE;
  const today = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const totalMax = tables.reduce((s, t) => s + (Number(t.capacity_max) || 0), 0);
  const byZone = zones.map(z => ({ name: z.name, tables: tables.filter(t => t.zone_id === z.id).sort(byName) }));
  const noZone = tables.filter(t => !t.zone_id).sort(byName);
  if (noZone.length) byZone.push({ name: 'Sin zona', tables: noZone });

  const head = (subtitle) => `
    <div class="pdf-head">
      <div>
        <h1 class="pdf-title">${esc(restaurant.name)}</h1>
        <div class="pdf-sub">${esc(plan.name)}${plan.is_default ? ' · plano por defecto' : ''} · ${esc(subtitle)}</div>
      </div>
      <div class="pdf-meta">${restaurant.address ? esc(restaurant.address) + '<br>' : ''}Exportado el ${today}</div>
    </div>`;

  const legend = byZone.filter(z => z.tables.length).map(z => {
    const st = z.name === 'Sin zona' ? NO_ZONE : zoneStyle(z.name);
    const cap = z.tables.reduce((s, t) => s + (Number(t.capacity_max) || 0), 0);
    return `<span><i style="background:${st.fill};border-color:${st.stroke};${isBar(z.name) ? 'border-radius:50%' : ''}"></i>${esc(z.name)} · ${z.tables.length} mesas · ${cap} pax</span>`;
  }).join('');

  const svg = buildSvg(tables, zoneStyle, restaurant.name === 'Saona Plaza España');

  const page1 = `
    <section class="pdf-page"><div class="pdf-page-inner">
      ${head('Plano de sala')}
      <div class="pdf-kpis">
        <span><b>${tables.length}</b> mesas</span>
        <span><b>${totalMax}</b> comensales de aforo máximo</span>
        <span><b>${combos.length}</b> combinaciones</span>
      </div>
      <div class="pdf-legend">${legend}<span class="muted">Cada mesa: nombre y aforo mín-máx</span></div>
      <div class="pdf-plan">${svg || '<p class="muted">Ninguna mesa de este plano tiene posición guardada.</p>'}</div>
      <div class="pdf-foot"><span>Grupo Saona · Sistema de reservas</span><span>Hoja 1</span></div>
    </div></section>`;

  const zoneTables = byZone.filter(z => z.tables.length).map(z => `
    <div class="pdf-zone">
      <h3>${esc(z.name)} <span>${z.tables.length} mesas · ${z.tables.reduce((s, t) => s + (Number(t.capacity_max) || 0), 0)} pax</span></h3>
      <table class="pdf-table">
        <thead><tr><th>Mesa</th><th class="num">Aforo</th></tr></thead>
        <tbody>${z.tables.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${t.capacity_min}-${t.capacity_max}</td></tr>`).join('')}</tbody>
      </table>
    </div>`).join('');

  const combosSorted = [...combos].sort((a, b) => (b.tables.length > 15) - (a.tables.length > 15) || byName(a, b));
  const comboRows = combosSorted.length
    ? `<table class="pdf-table">
        <thead><tr><th>Combinación</th><th>Mesas</th><th class="num">Aforo</th></tr></thead>
        <tbody>${combosSorted.map(c => {
          const names = c.tables.map(t => t.name).sort((a, b) => String(a).localeCompare(String(b), 'es', { numeric: true }));
          const shown = names.length > 12 ? `${names.length} mesas (${esc(names.slice(0, 6).join(', '))}…)` : esc(names.join(' + '));
          const aforo = c.capacity_min != null ? `${c.capacity_min}-${c.combinedMax}` : `hasta ${c.combinedMax}`;
          return `<tr><td>${esc(c.name)}</td><td>${shown}</td><td class="num">${aforo}</td></tr>`;
        }).join('')}</tbody>
      </table>`
    : '<p class="muted">Este plano no tiene combinaciones.</p>';

  const page2 = `
    <section class="pdf-page pdf-page-list" id="listPage"><div class="pdf-page-inner">
      ${head('Mesas y combinaciones')}
      <div class="pdf-cols">
        <div class="pdf-section"><h2>Mesas por zona</h2><div class="pdf-zones">${zoneTables || '<p class="muted">Sin mesas.</p>'}</div></div>
        <div class="pdf-section"><h2>Combinaciones (${combos.length})</h2>${comboRows}</div>
      </div>
      <div class="pdf-foot"><span>Grupo Saona · Sistema de reservas</span><span>Hoja 2</span></div>
    </div></section>`;

  $('doc').innerHTML = page1 + page2;
  document.title = `Plano ${restaurant.name} – ${plan.name}`; // nombre sugerido del PDF
}

window.addEventListener('DOMContentLoaded', async () => {
  if (!(await guardAdminPage())) return;
  $('printBtn').addEventListener('click', () => window.print());
  $('closeBtn').addEventListener('click', () => (history.length > 1 ? history.back() : window.close()));
  $('optList').addEventListener('change', (e) => {
    const p = $('listPage');
    if (p) p.style.display = e.target.checked ? '' : 'none';
  });

  try {
    const [restaurant, plans] = await Promise.all([
      api(`/api/restaurants/${RESTAURANT_ID}`),
      api(`/api/floor-plans?restaurantId=${RESTAURANT_ID}`),
    ]);
    const plan = plans.find(p => p.id === PLAN_ID) || plans.find(p => p.is_default) || plans[0];
    if (!plan) throw new Error('Este local no tiene ningún plano de sala.');
    const [zones, tables, combos] = await Promise.all([
      api(`/api/zones?restaurantId=${RESTAURANT_ID}&floorPlanId=${plan.id}`),
      api(`/api/tables?restaurantId=${RESTAURANT_ID}&floorPlanId=${plan.id}`),
      api(`/api/combinations?restaurantId=${RESTAURANT_ID}&floorPlanId=${plan.id}`),
    ]);
    render({ restaurant, plan, zones, tables, combos });
    if (params.get('print') === '1') setTimeout(() => window.print(), 300);
  } catch (err) {
    $('doc').innerHTML = `<p class="error">No se pudo cargar el plano: ${esc(err.message)}</p>`;
  }
});
