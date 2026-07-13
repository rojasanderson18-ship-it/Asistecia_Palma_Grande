/* ── MÓDULO: Cola offline ── */

const APP_VERSION_CLIENT = '4.0';

// Enriquece el payload con deviceToken y appVersion antes de enviarlo
function _enriquecerPayload(p) {
  const tok = (typeof getDeviceToken === 'function') ? getDeviceToken() : null;
  const base = Object.assign({}, p);
  if (tok && !base.deviceToken) base.deviceToken = tok;
  if (!base.appVersion) base.appVersion = APP_VERSION_CLIENT;
  return base;
}

function enviar(p) {
  const payload = _enriquecerPayload(p);
  if (!CONFIG.GS_URL || CONFIG.GS_URL.includes('PEGAR')) {
    const c = JSON.parse(localStorage.getItem('cola') || '[]');
    c.push(payload); localStorage.setItem('cola', JSON.stringify(c));
    return;
  }
  fetch(CONFIG.GS_URL, {method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(payload)})
    .catch(() => {
      const c = JSON.parse(localStorage.getItem('cola') || '[]');
      c.push(payload); localStorage.setItem('cola', JSON.stringify(c));
    });
}

function enviarConResp(p) {
  const payload = _enriquecerPayload(p);
  if (!CONFIG.GS_URL || CONFIG.GS_URL.includes('PEGAR')) return Promise.resolve(null);
  return fetch(CONFIG.GS_URL, {method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(payload)})
    .then(r => r.json())
    .catch(e => ({ok:false, error:e.message}));
}

let _reintentando = false;
async function reintentarCola() {
  if (_reintentando) return;
  const c = JSON.parse(localStorage.getItem('cola') || '[]');
  if (!c.length) return;
  _reintentando = true;
  const pendientes = [];
  for (const item of c) {
    // Asegurar que el deviceToken más reciente acompañe los items de la cola
    const payload = _enriquecerPayload(item);
    try {
      const r = await fetch(CONFIG.GS_URL, {method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(payload)});
      const d = await r.json();
      if (!d || !d.ok) pendientes.push(payload);
    } catch {
      pendientes.push(payload);
    }
  }
  localStorage.setItem('cola', JSON.stringify(pendientes));
  _reintentando = false;
  updColaBadge();
}

function updColaBadge() {
  const c = JSON.parse(localStorage.getItem('cola') || '[]');
  const badge = document.getElementById('colaBadge');
  const cnt = document.getElementById('colaCnt');
  if (!badge) return;
  if (c.length > 0) { badge.style.display = 'block'; if (cnt) cnt.textContent = c.length; }
  else { badge.style.display = 'none'; }
}

window.addEventListener('online', reintentarCola);
setInterval(reintentarCola, 120000);
setTimeout(() => { reintentarCola(); updColaBadge(); }, 3000);
