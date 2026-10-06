// Página de informes (admin/informes.html). El servidor devuelve cada informe como
// JSON ({ columns, rows }) desde /api/reports/:id y aquí se convierte en CSV, Excel
// (SheetJS, cargado desde cdnjs) o en una tabla para verlo en pantalla.

const $ = (id) => document.getElementById(id);
const state = { catalog: null, restaurants: [] };

// --- Fechas -------------------------------------------------------------------
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function rangeFor(kind) {
  const now = new Date();
  const d = (y, m, day) => new Date(y, m, day);
  const y = now.getFullYear(), m = now.getMonth(), day = now.getDate();
  const mondayOffset = (now.getDay() + 6) % 7; // lunes = 0
  switch (kind) {
    case 'today': return [now, now];
    case 'yesterday': { const a = d(y, m, day - 1); return [a, a]; }
    case 'week': return [d(y, m, day - mondayOffset), d(y, m, day - mondayOffset + 6)];
    case 'lastweek': return [d(y, m, day - mondayOffset - 7), d(y, m, day - mondayOffset - 1)];
    case 'lastmonth': return [d(y, m - 1, 1), d(y, m, 0)];
    case 'year': return [d(y, 0, 1), d(y, 11, 31)];
    default: return [d(y, m, 1), d(y, m + 1, 0)]; // este mes
  }
}
function setRange(kind) {
  const [a, b] = rangeFor(kind);
  $('fFrom').value = iso(a);
  $('fTo').value = iso(b);
}

// --- Petición de un informe -------------------------------------------------------
function baseParams() {
  return {
    restaurantId: $('fLocal').value,
    from: $('fFrom').value,
    to: $('fTo').value,
    dateType: $('fDateType').value,
  };
}

async function fetchReport(id, extra = {}) {
  const qs = new URLSearchParams({ ...baseParams(), ...extra });
  const res = await fetch(`/api/reports/${id}?${qs}`);
  if (res.status === 401) { location.href = '/admin/login.html?next=' + encodeURIComponent(location.pathname); throw new Error('Sesión caducada'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No se pudo generar el informe.');
  return data;
}

// Parámetros propios de un informe, leídos de los controles de su fila.
function extraParams(report, row) {
  const extra = {};
  for (const p of report.params) {
    const el = row.querySelector(`[data-param="${p}"]`);
    if (el && el.value) extra[p] = el.value;
  }
  return extra;
}

// --- Conversión a CSV / Excel -----------------------------------------------------
// Postgres devuelve los decimales (ROUND) como texto "4.50": se pasan a número.
const DECIMAL = /^-?\d+\.\d+$/;
const toCell = v => (typeof v === 'string' && DECIMAL.test(v) ? Number(v) : v ?? '');

function localSlug() {
  if ($('fLocal').value === 'all') return 'todos-los-locales';
  const r = state.restaurants.find(x => String(x.id) === $('fLocal').value);
  return (r ? r.name : 'local').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
const fileBase = id => `informe-${id}-${localSlug()}-${$('fFrom').value}_${$('fTo').value}`;

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// CSV pensado para abrirse con Excel en español: separador ";" y coma decimal, con BOM.
function toCsv(data) {
  const esc = v => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'number' && !Number.isInteger(v)) s = s.replace('.', ',');
    if (typeof v === 'string' && DECIMAL.test(v)) s = v.replace('.', ',');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [data.columns.map(esc).join(';'), ...data.rows.map(r => r.map(esc).join(';'))];
  return '﻿' + lines.join('\r\n');
}

function sheetFor(data) {
  const ws = XLSX.utils.aoa_to_sheet([data.columns, ...data.rows.map(r => r.map(toCell))]);
  ws['!cols'] = data.columns.map((c, i) => {
    const longest = Math.max(String(c).length, ...data.rows.slice(0, 200).map(r => String(r[i] ?? '').length));
    return { wch: Math.min(Math.max(longest + 2, 8), 50) };
  });
  ws['!autofilter'] = { ref: ws['!ref'] };
  return ws;
}

// Nombre de hoja de Excel: máx. 31 caracteres, sin []:*?/\ y sin repetir.
function sheetName(title, used) {
  let base = title.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  let name = base, n = 2;
  while (used.has(name.toLowerCase())) { const suf = ` (${n++})`; name = base.slice(0, 31 - suf.length) + suf; }
  used.add(name.toLowerCase());
  return name;
}

function xlsxReady() {
  if (window.XLSX) return true;
  alert('No se ha podido cargar el generador de Excel (¿sin conexión a internet?). Descarga el CSV, que también se abre con Excel.');
  return false;
}

// --- Tabla en pantalla --------------------------------------------------------------
const MAX_PREVIEW = 300;
function renderPreview(box, data) {
  if (!data.rows.length) {
    box.innerHTML = '<div class="rep-empty">No hay datos para estos filtros.</div>';
    return;
  }
  const table = document.createElement('table');
  const thead = table.createTHead().insertRow();
  data.columns.forEach(c => { const th = document.createElement('th'); th.textContent = c; thead.appendChild(th); });
  const tbody = table.createTBody();
  data.rows.slice(0, MAX_PREVIEW).forEach(r => {
    const tr = tbody.insertRow();
    r.forEach(v => {
      const td = tr.insertCell();
      const cell = toCell(v);
      td.textContent = typeof cell === 'number' ? cell.toLocaleString('es-ES') : cell;
      if (typeof cell === 'number') td.className = 'num';
    });
  });
  box.innerHTML = '';
  box.appendChild(table);
}

// --- Pintar el catálogo -----------------------------------------------------------
function extraControls(report) {
  const parts = [];
  if (report.params.includes('status')) {
    const opts = state.catalog.statusFilters.map(f => `<option value="${f.id}">${f.label}</option>`).join('');
    parts.push(`<label>Estado <select data-param="status">${opts}</select></label>`);
  }
  if (report.params.includes('hours')) {
    const hs = [1, 2, 3, 4, 5, 6, 8, 10, 12, 24, 48, 72, 96, 120, 168];
    const opts = hs.map(h => `<option value="${h}" ${h === 24 ? 'selected' : ''}>${h < 48 ? `${h} hora${h > 1 ? 's' : ''}` : `${h / 24} días`}</option>`).join('');
    parts.push(`<label>Horas antes de su reserva <select data-param="hours">${opts}</select></label>`);
  }
  if (report.params.includes('split')) {
    parts.push(`<label>Split horario (opcional) <input data-param="split" placeholder="17:00" pattern="\\d{1,2}:\\d{2}"></label>`);
  }
  if (!report.params.includes('dateType')) {
    parts.push('<span>· usa siempre la fecha de la reserva</span>');
  }
  return parts.length ? `<div class="rep-extra">${parts.join('')}</div>` : '';
}

function renderCatalog() {
  const container = $('reportGroups');
  container.innerHTML = '';
  const groups = [...new Set(state.catalog.reports.map(r => r.group))];
  for (const g of groups) {
    const card = document.createElement('section');
    card.className = 'cfg-card rep-group';
    card.innerHTML = `<h2>${g}</h2>`;
    for (const report of state.catalog.reports.filter(r => r.group === g)) {
      const row = document.createElement('div');
      row.className = 'rep-row';
      row.innerHTML = `
        <div class="rep-head">
          <div class="rep-text">
            <div class="rep-title"></div>
            <div class="rep-desc"></div>
            ${extraControls(report)}
          </div>
          <div class="rep-actions">
            <button type="button" data-act="csv">CSV</button>
            <button type="button" data-act="xlsx">Excel</button>
            <button type="button" data-act="view">Ver tabla</button>
          </div>
        </div>
        <div class="rep-msg"></div>
        <div class="rep-preview hidden"></div>`;
      row.querySelector('.rep-title').textContent = report.title;
      row.querySelector('.rep-desc').textContent = report.description;
      row.querySelectorAll('.rep-actions button').forEach(btn =>
        btn.addEventListener('click', () => runAction(report, row, btn)));
      card.appendChild(row);
    }
    container.appendChild(card);
  }
  $('notAvailable').innerHTML = state.catalog.notAvailable
    .map(n => `<li><strong>${n.title}</strong> — ${n.reason}</li>`).join('');
}

async function runAction(report, row, btn) {
  const act = btn.dataset.act;
  if (act === 'xlsx' && !xlsxReady()) return;
  const msg = row.querySelector('.rep-msg');
  const preview = row.querySelector('.rep-preview');
  if (act === 'view' && !preview.classList.contains('hidden')) {
    preview.classList.add('hidden');
    btn.textContent = 'Ver tabla';
    return;
  }
  const buttons = row.querySelectorAll('.rep-actions button');
  buttons.forEach(b => { b.disabled = true; });
  msg.className = 'rep-msg';
  msg.textContent = 'Generando…';
  try {
    const data = await fetchReport(report.id, extraParams(report, row));
    msg.textContent = `${data.rows.length.toLocaleString('es-ES')} fila${data.rows.length === 1 ? '' : 's'}` +
      (act === 'view' && data.rows.length > MAX_PREVIEW ? ` (se muestran las ${MAX_PREVIEW} primeras; descarga el archivo para verlas todas)` : '');
    if (act === 'csv') {
      download(new Blob([toCsv(data)], { type: 'text/csv;charset=utf-8' }), `${fileBase(report.id)}.csv`);
    } else if (act === 'xlsx') {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheetFor(data), sheetName(report.sheet || report.title, new Set()));
      XLSX.writeFile(wb, `${fileBase(report.id)}.xlsx`, { compression: true });
    } else {
      renderPreview(preview, data);
      preview.classList.remove('hidden');
      btn.textContent = 'Ocultar tabla';
    }
  } catch (err) {
    msg.className = 'rep-msg error';
    msg.textContent = err.message;
  } finally {
    buttons.forEach(b => { b.disabled = false; });
  }
}

// Un solo Excel con una hoja por informe (con los filtros de cada fila tal cual estén).
async function downloadAll() {
  if (!xlsxReady()) return;
  const btn = $('allBtn');
  const status = $('allStatus');
  btn.disabled = true;
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const failed = [];
  const reports = state.catalog.reports;
  const rows = [...document.querySelectorAll('.rep-row')];
  for (let i = 0; i < reports.length; i++) {
    status.textContent = `Generando ${i + 1} de ${reports.length}: ${reports[i].title}…`;
    try {
      const data = await fetchReport(reports[i].id, extraParams(reports[i], rows[i]));
      XLSX.utils.book_append_sheet(wb, sheetFor(data), sheetName(reports[i].sheet || reports[i].title, used));
    } catch (err) {
      failed.push(reports[i].title);
    }
  }
  XLSX.writeFile(wb, `informes-${localSlug()}-${$('fFrom').value}_${$('fTo').value}.xlsx`, { compression: true });
  status.textContent = failed.length
    ? `Descargado, pero no se pudieron generar: ${failed.join(', ')}.`
    : `Descargado: ${reports.length} informes, una hoja por informe.`;
  btn.disabled = false;
}

// --- Panel visual: KPIs y gráficos (Chart.js, cargado desde cdnjs) -----------------
// Colores por papel: serie 1 azul (Comida / serie única), serie 2 naranja (Cena).
// Paleta validada para daltonismo (comprobador de la guía de visualización).
const VIZ = {
  s1: '#2a78d6', s2: '#eb6834', surface: '#ffffff',
  text: '#1c1c1c', muted: '#6b6b6b', grid: '#ecebe7',
};
const charts = {};
const fmt = n => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('es-ES'));

function kpiTile(label, value, sub) {
  return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

function renderKpis(k) {
  $('kpis').innerHTML = [
    kpiTile('Reservas', fmt(k.reservas)),
    kpiTile('Comensales', fmt(k.personas)),
    kpiTile('Pax medio', fmt(k.paxMedio), 'por reserva'),
    kpiTile('No show', k.pctNoShow == null ? '—' : `${fmt(k.pctNoShow)} %`, `${fmt(k.noShow)} reservas`),
    kpiTile('Cancelaciones', fmt(k.canceladas), k.total ? `${fmt(Math.round(1000 * k.canceladas / k.total) / 10)} % del total` : ''),
    kpiTile('Antelación media', k.antelacion == null ? '—' : `${fmt(k.antelacion)} días`, 'entre reservar y venir'),
  ].join('');
}

// Agrupa la serie diaria por semana o por mes cuando el rango es largo, para que
// las barras sigan siendo legibles.
function bucketDays(dias) {
  const n = dias.length;
  if (n <= 62) {
    return dias.map(d => ({
      label: `${d.dia.slice(8, 10)}/${d.dia.slice(5, 7)}`,
      title: new Date(d.dia + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }),
      comida: d.comida, cena: d.cena,
    }));
  }
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const byKey = new Map();
  for (const d of dias) {
    const date = new Date(d.dia + 'T12:00:00');
    let key, label;
    if (n <= 180) {
      const monday = new Date(date); monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      key = iso(monday); label = `Sem. ${key.slice(8, 10)}/${key.slice(5, 7)}`;
    } else {
      key = d.dia.slice(0, 7); label = `${MESES[date.getMonth()]} ${String(date.getFullYear()).slice(2)}`;
    }
    const b = byKey.get(key) || { label, title: label, comida: 0, cena: 0 };
    b.comida += d.comida; b.cena += d.cena;
    byKey.set(key, b);
  }
  return [...byKey.values()];
}

function baseOptions(extra = {}) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false, locale: 'es-ES',
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#1c1c1c', padding: 10, cornerRadius: 8, boxPadding: 4,
        titleFont: { weight: '600' }, usePointStyle: true,
        callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.parsed[c.chart.options.indexAxis === 'y' ? 'x' : 'y'])}` },
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: VIZ.grid }, ticks: { color: VIZ.muted, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 8 } },
      y: { beginAtZero: true, grid: { color: VIZ.grid }, border: { display: false }, ticks: { color: VIZ.muted, font: { size: 11 }, precision: 0 } },
    },
    ...extra,
  };
}

// Barras finas, extremo redondeado de 4px (el pegado al eje queda recto) y 2px de hueco
// entre barras y entre tramos apilados (borde del color del fondo).
// En pantallas estrechas con muchas barras, el hueco baja a 1px para que no se coma la barra.
const barStyle = color => ({
  backgroundColor: color, borderColor: VIZ.surface,
  borderWidth: c => (c.chart.chartArea && c.chart.chartArea.width / Math.max(1, c.chart.data.labels.length) < 14 ? 1 : 2),
  borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, categoryPercentage: 0.8, barPercentage: 0.9,
});

function draw(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), config);
}

function renderCharts(d) {
  if (!window.Chart) {
    $('dashEmpty').textContent = 'No se han podido cargar los gráficos (¿sin conexión a internet?). Los informes siguen disponibles abajo.';
    $('dashEmpty').hidden = false;
    return;
  }
  // 1) Comensales por día, Comida + Cena apiladas.
  const b = bucketDays(d.porDia);
  $('legendDia').innerHTML = `<span><i style="background:${VIZ.s1}"></i>Comida</span><span><i style="background:${VIZ.s2}"></i>Cena</span>`;
  draw('chDia', {
    type: 'bar',
    data: {
      labels: b.map(x => x.label),
      datasets: [
        { label: 'Comida', data: b.map(x => x.comida), ...barStyle(VIZ.s1), borderRadius: 0, stack: 's' },
        { label: 'Cena', data: b.map(x => x.cena), ...barStyle(VIZ.s2), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: false, stack: 's' },
      ],
    },
    options: baseOptions({
      scales: { ...baseOptions().scales, x: { ...baseOptions().scales.x, stacked: true }, y: { ...baseOptions().scales.y, stacked: true } },
      plugins: {
        ...baseOptions().plugins,
        tooltip: {
          ...baseOptions().plugins.tooltip,
          callbacks: {
            ...baseOptions().plugins.tooltip.callbacks,
            title: items => b[items[0].dataIndex].title,
            footer: items => `Total: ${fmt(items.reduce((s, i) => s + i.parsed.y, 0))}`,
          },
        },
      },
    }),
  });

  // 2) Comensales por hora de la reserva.
  draw('chHora', {
    type: 'bar',
    data: { labels: d.porHora.map(h => `${h.hora}:00`), datasets: [{ label: 'Comensales', data: d.porHora.map(h => h.personas), ...barStyle(VIZ.s1) }] },
    options: baseOptions(),
  });

  // 3) Reservas por canal (barras horizontales, con el % en la etiqueta).
  const totalCanal = d.porCanal.reduce((s, c) => s + c.reservas, 0) || 1;
  draw('chCanal', {
    type: 'bar',
    data: {
      labels: d.porCanal.map(c => `${c.canal} · ${Math.round(100 * c.reservas / totalCanal)} %`),
      datasets: [{ label: 'Reservas', data: d.porCanal.map(c => c.reservas), ...barStyle(VIZ.s1) }],
    },
    options: baseOptions({
      indexAxis: 'y',
      scales: {
        x: { ...baseOptions().scales.y, grid: { color: VIZ.grid } },
        y: { grid: { display: false }, border: { color: VIZ.grid }, ticks: { color: VIZ.text, font: { size: 12 } } },
      },
    }),
  });

  // 4) Todos los locales → ranking de comensales por local; un local → estados de las reservas.
  if (d.all) {
    const top = d.porLocal.slice(0, 15);
    $('cap4').textContent = d.porLocal.length > 15
      ? `Comensales por local (15 primeros de ${d.porLocal.length})` : 'Comensales por local';
    $('box4').style.height = `${Math.max(160, top.length * 30 + 40)}px`;
    draw('ch4', {
      type: 'bar',
      data: { labels: top.map(l => l.local), datasets: [{ label: 'Comensales', data: top.map(l => l.personas), ...barStyle(VIZ.s1) }] },
      options: baseOptions({
        indexAxis: 'y',
        scales: {
          x: { ...baseOptions().scales.y, grid: { color: VIZ.grid } },
          y: { grid: { display: false }, border: { color: VIZ.grid }, ticks: { color: VIZ.text, font: { size: 12 }, autoSkip: false } },
        },
        plugins: {
          ...baseOptions().plugins,
          tooltip: {
            ...baseOptions().plugins.tooltip,
            callbacks: {
              label: c => ` Comensales: ${fmt(c.parsed.x)}`,
              afterLabel: c => [` Reservas: ${fmt(top[c.dataIndex].reservas)}`,
                ` No show: ${top[c.dataIndex].pct_no_show == null ? '—' : fmt(top[c.dataIndex].pct_no_show) + ' %'}`],
            },
          },
        },
      }),
    });
  } else {
    $('cap4').textContent = 'Estado de las reservas';
    $('box4').style.height = `${Math.max(160, d.porEstado.length * 30 + 40)}px`;
    draw('ch4', {
      type: 'bar',
      data: { labels: d.porEstado.map(e => e.estado), datasets: [{ label: 'Reservas', data: d.porEstado.map(e => e.reservas), ...barStyle(VIZ.s1) }] },
      options: baseOptions({
        indexAxis: 'y',
        scales: {
          x: { ...baseOptions().scales.y, grid: { color: VIZ.grid } },
          y: { grid: { display: false }, border: { color: VIZ.grid }, ticks: { color: VIZ.text, font: { size: 12 } } },
        },
      }),
    });
  }
}

// Carga el panel con los filtros actuales (también al cambiar cualquier filtro).
let dashSeq = 0;
async function calculate() {
  const seq = ++dashSeq;
  const sel = $('fLocal');
  $('dashScope').textContent = `${sel.options[sel.selectedIndex]?.text.replace(/ \(\d+\)$/, '') || ''} · ${$('fFrom').value} a ${$('fTo').value}`;
  try {
    const res = await fetch(`/api/reports/dashboard?${new URLSearchParams(baseParams())}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'No se pudo cargar el resumen.');
    if (seq !== dashSeq) return; // llegó otra petición más nueva mientras tanto
    renderKpis(d.kpis);
    const vacio = d.kpis.total === 0;
    $('dashEmpty').textContent = 'No hay reservas en este periodo con estos filtros.';
    $('dashEmpty').hidden = !vacio;
    document.querySelector('.chart-grid').hidden = vacio;
    if (!vacio) renderCharts(d);
  } catch (err) {
    $('kpis').innerHTML = '';
    $('dashEmpty').textContent = err.message;
    $('dashEmpty').hidden = false;
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  if (!(await guardAdminPage())) return;
  renderSessionBar($('sessionBar'));
  setRange('month');

  const [catRes, restRes] = await Promise.all([fetch('/api/reports'), fetch('/api/restaurants')]);
  state.catalog = await catRes.json();
  state.restaurants = restRes.ok ? await restRes.json() : [];

  const sel = $('fLocal');
  const current = getRestaurantId(); // local elegido en el resto del panel (authbar.js)
  sel.innerHTML = `<option value="all">Todos los locales (${state.restaurants.length})</option>` +
    state.restaurants.map(r => `<option value="${r.id}" ${r.id === current ? 'selected' : ''}>${r.name}</option>`).join('');

  renderCatalog();
  $('quickRanges').addEventListener('click', e => {
    if (e.target.dataset.range) { setRange(e.target.dataset.range); calculate(); }
  });
  ['fLocal', 'fFrom', 'fTo', 'fDateType'].forEach(id => $(id).addEventListener('change', calculate));
  $('calcBtn').addEventListener('click', calculate);
  $('allBtn').addEventListener('click', downloadAll);
  calculate();
});
