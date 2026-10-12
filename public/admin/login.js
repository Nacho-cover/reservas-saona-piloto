const $ = (id) => document.getElementById(id);

function nextUrl() {
  const params = new URLSearchParams(location.search);
  const next = params.get('next') || '/admin/';
  // Solo rutas del propio panel (evita redirigir a otra web con ?next=https://...).
  return /^\/admin\//.test(next) ? next : '/admin/';
}

function show(form) {
  $('loginForm').classList.toggle('hidden', form !== 'login');
  $('forgotForm').classList.toggle('hidden', form !== 'forgot');
}

window.addEventListener('DOMContentLoaded', () => {
  // Si ya hay sesión activa, no hace falta volver a entrar.
  fetch('/api/admin/session').then(r => r.json()).then(d => {
    if (d.authenticated) location.href = nextUrl();
  });

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    const btn = $('loginBtn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('loginUser').value.trim(), password: $('loginPass').value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo iniciar sesión');
      location.href = nextUrl();
    } catch (err) {
      $('loginError').textContent = err.message;
      btn.disabled = false;
    }
  });

  $('forgotLink').addEventListener('click', () => {
    $('forgotEmail').value = $('loginUser').value.trim();
    $('forgotMsg').textContent = '';
    show('forgot');
    $('forgotEmail').focus();
  });
  $('backToLogin').addEventListener('click', () => show('login'));

  $('forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('forgotMsg');
    msg.style.color = '';
    msg.textContent = '';
    const btn = $('forgotBtn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/admin/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('forgotEmail').value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo enviar');
      msg.style.color = 'var(--brand-dark)';
      msg.textContent = data.message;
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
});
