// Apartado «Integración (API)» de Configuración de sala: direcciones de la API de
// planos (/api/v1) para el local y plano seleccionados, botón «Probar» (usa la
// sesión del panel, sin clave) y gestión de claves de acceso.
// Depende de config.js (RESTAURANT_ID, state, api, escapeHtml, $).

(function () {
  const BASE = `${location.origin}/api/v1`;
  const todayIso = () => new Date().toISOString().slice(0, 10);
  // Las fechas vienen de la base de datos en UTC ('YYYY-MM-DD HH:MM:SS'): mostrar en hora local.
  const fmtDate = (s, withTime) => {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return s;
    return withTime
      ? d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  function endpoints() {
    const planId = state.selectedPlanId;
    const planName = (state.plans.find(p => p.id === planId) || {}).name || '';
    return [
      { label: 'Todos los locales', hint: 'lista con sus planos', path: '/restaurants' },
      { label: 'Este local', hint: 'con su plano por defecto', path: `/restaurants/${RESTAURANT_ID}` },
      { label: 'Este local, todos los planos', hint: `${state.plans.length} planos`, path: `/restaurants/${RESTAURANT_ID}?plans=all` },
      { label: 'Este plano', hint: planName, path: `/floor-plans/${planId}` },
      { label: 'Plano que aplica un día', hint: 'según la agenda', path: `/restaurants/${RESTAURANT_ID}?date=`, date: true },
      { label: 'Volcado completo', hint: 'todos los locales y planos', path: '/export?plans=all' },
    ];
  }

  function renderEndpoints() {
    const box = $('apiEndpoints');
    if (!box || !state.selectedPlanId) return;
    box.innerHTML = '';
    for (const ep of endpoints()) {
      const row = document.createElement('div');
      row.className = 'api-row';
      row.innerHTML = `
        <div class="api-label">${escapeHtml(ep.label)}<small>${escapeHtml(ep.hint || '')}</small></div>
        <div style="display:flex; gap:6px; align-items:center; min-width:0">
          <input type="text" readonly>
          ${ep.date ? `<input type="date" value="${todayIso()}">` : ''}
        </div>
        <button class="btn btn-secondary" type="button" data-act="copy">Copiar</button>
        <button class="btn btn-secondary" type="button" data-act="test">Probar</button>`;
      const urlInput = row.querySelector('input[type=text]');
      const dateInput = row.querySelector('input[type=date]');
      const url = () => BASE + ep.path + (ep.date ? (dateInput.value || todayIso()) : '');
      const refresh = () => { urlInput.value = url(); };
      refresh();
      if (dateInput) dateInput.addEventListener('change', refresh);
      row.querySelector('[data-act=copy]').addEventListener('click', async (e) => {
        await copyText(url());
        flash(e.target, 'Copiado');
      });
      row.querySelector('[data-act=test]').addEventListener('click', () => preview(url()));
      box.appendChild(row);
    }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t);
      t.select(); document.execCommand('copy'); t.remove();
    }
  }
  function flash(btn, text) {
    const old = btn.textContent; btn.textContent = text; btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1200);
  }

  async function preview(url) {
    const box = $('apiPreview');
    box.classList.remove('hidden');
    $('apiPreviewMeta').textContent = 'Cargando…';
    $('apiPreviewBody').textContent = '';
    const t0 = performance.now();
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      const text = await res.text();
      const ms = Math.round(performance.now() - t0);
      const kb = (new Blob([text]).size / 1024);
      let body = text;
      try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* no es JSON */ }
      const MAX = 20000;
      $('apiPreviewMeta').textContent =
        `${res.status} ${res.ok ? 'OK' : ''} · ${kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB'} · ${ms} ms` +
        (body.length > MAX ? ' · mostrando el principio' : '');
      $('apiPreviewBody').textContent = body.length > MAX ? body.slice(0, MAX) + '\n…' : body;
    } catch (err) {
      $('apiPreviewMeta').textContent = 'Error: ' + err.message;
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // --- Claves --------------------------------------------------------------
  async function loadKeys() {
    const list = $('apiKeysList');
    let keys = [];
    try { keys = await api('/api/admin/api-keys'); } catch (err) {
      list.innerHTML = `<p class="cfg-hint">No se pudieron cargar las claves: ${escapeHtml(err.message)}</p>`;
      return;
    }
    if (!keys.length) { list.innerHTML = '<p class="cfg-hint">Todavía no hay ninguna clave.</p>'; return; }
    list.innerHTML = '';
    for (const k of keys) {
      const row = document.createElement('div');
      row.className = 'table-row' + (k.revokedAt ? ' api-key-revoked' : '');
      const meta = k.revokedAt
        ? `revocada el ${escapeHtml(fmtDate(k.revokedAt))}`
        : `${k.prefix ? escapeHtml(k.prefix) + '… · ' : ''}creada el ${escapeHtml(fmtDate(k.createdAt))} · ${k.lastUsedAt ? 'último uso ' + escapeHtml(fmtDate(k.lastUsedAt, true)) : 'sin usar todavía'}`;
      row.innerHTML = `<span class="t-name">${escapeHtml(k.label)}</span><span class="t-meta">${meta}</span>`;
      if (!k.revokedAt) {
        const del = document.createElement('button');
        del.textContent = 'Revocar';
        del.addEventListener('click', async () => {
          if (!confirm(`¿Revocar la clave «${k.label}»? La aplicación que la use dejará de poder leer los planos en menos de un minuto.`)) return;
          await api(`/api/admin/api-keys/${k.id}`, { method: 'DELETE' });
          await loadKeys();
        });
        row.appendChild(del);
      }
      list.appendChild(row);
    }
  }

  async function createKey(e) {
    e.preventDefault();
    const label = $('apiKeyLabel').value.trim();
    if (!label) return;
    try {
      const k = await api('/api/admin/api-keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
      });
      $('apiKeyNewLabel').textContent = k.label;
      $('apiKeyNewValue').value = k.key;
      $('apiKeyNew').classList.remove('hidden');
      $('apiKeyLabel').value = '';
      await loadKeys();
    } catch (err) {
      alert(err.message);
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    if (!$('apiCard')) return;
    $('apiPreviewClose').addEventListener('click', () => $('apiPreview').classList.add('hidden'));
    $('apiKeyForm').addEventListener('submit', createKey);
    $('apiKeyNewCopy').addEventListener('click', async (e) => {
      await copyText($('apiKeyNewValue').value);
      flash(e.target, 'Copiada');
    });
    $('planSelect').addEventListener('change', () => setTimeout(renderEndpoints, 0));
    // config.js carga los planos de forma asíncrona: esperar a que haya plano seleccionado.
    const wait = setInterval(() => {
      if (state.selectedPlanId) { clearInterval(wait); renderEndpoints(); }
    }, 200);
    setTimeout(() => clearInterval(wait), 30000);
    loadKeys();
  });
})();
