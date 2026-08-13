const $ = (id) => document.getElementById(id);

function nextUrl() {
  const params = new URLSearchParams(location.search);
  return params.get('next') || '/admin/';
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
});
