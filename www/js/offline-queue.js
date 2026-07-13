/* ── MÓDULO: Cola offline ── */

function enviar(p) {
  if (!CONFIG.GS_URL || CONFIG.GS_URL.includes('PEGAR')) {
    const c = JSON.parse(localStorage.getItem('cola') || '[]');
    c.push(p); localStorage.setItem('cola', JSON.stringify(c));
    return;
  }
  fetch(CONFIG.GS_URL, {method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(p)})
    .catch(() => {
      const c = JSON.parse(localStorage.getItem('cola') || '[]');
      c.push(p); localStorage.setItem('cola', JSON.stringify(c));
    });
}

function enviarConResp(p) {
  if (!CONFIG.GS_URL || CONFIG.GS_URL.includes('PEGAR')) return Promise.resolve(null);
  return fetch(CONFIG.GS_URL, {method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(p)})
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
    try {
      await fetch(CONFIG.GS_URL, {method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(item)});
    } catch {
      pendientes.push(item);
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
