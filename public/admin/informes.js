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

// "Calcular": totales del periodo (sin canceladas ni no show), como el contador de Cover.
async function calculate() {
  $('sumPax').textContent = '…';
  $('sumRes').textContent = '…';
  try {
    const data = await fetchReport('resumen_grupo');
    const col = name => data.columns.indexOf(name);
    const sum = idx => data.rows.reduce((s, r) => s + (Number(r[idx]) || 0), 0);
    $('sumPax').textContent = sum(col('Personas')).toLocaleString('es-ES');
    $('sumRes').textContent = sum(col('Reservas válidas')).toLocaleString('es-ES');
  } catch (err) {
    $('sumPax').textContent = '—';
    $('sumRes').textContent = '—';
    $('allStatus').textContent = err.message;
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
