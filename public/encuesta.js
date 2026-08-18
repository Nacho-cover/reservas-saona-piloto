const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const reservationId = params.get('r');
const token = params.get('t');

const ratings = { ratingGeneral: 0, ratingComida: 0, ratingServicio: 0 };

function showView(id) {
  ['loadingView', 'formView', 'doneView', 'invalidView'].forEach(v => $(v).classList.toggle('hidden', v !== id));
}

function renderStars(container, field) {
  container.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '★';
    btn.addEventListener('click', () => {
      ratings[field] = i;
      Array.from(container.children).forEach((c, idx) => c.classList.toggle('filled', idx < i));
    });
    container.appendChild(btn);
  }
}

async function init() {
  if (!reservationId || !token) { showView('invalidView'); return; }
  try {
    const res = await fetch(`/api/survey/${reservationId}?t=${encodeURIComponent(token)}`);
    if (!res.ok) { showView('invalidView'); return; }
    const data = await res.json();
    if (data.alreadyAnswered) { showView('doneView'); return; }

    $('title').textContent = `¿Qué tal tu visita a ${data.restaurantName}?`;
    document.querySelectorAll('.stars').forEach(el => renderStars(el, el.dataset.field));
    showView('formView');
  } catch (err) {
    showView('invalidView');
  }
}

async function submitSurvey() {
  const errorEl = $('formError');
  errorEl.textContent = '';
  if (!ratings.ratingGeneral || !ratings.ratingComida || !ratings.ratingServicio) {
    errorEl.textContent = 'Puntúa las tres valoraciones antes de enviar.';
    return;
  }
  const btn = $('submitBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/survey/${reservationId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...ratings, comentario: $('comentario').value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo enviar la valoración.');
    showView('doneView');
  } catch (err) {
    errorEl.textContent = err.message;
    btn.disabled = false;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  init();
  $('submitBtn').addEventListener('click', submitSurvey);
});
