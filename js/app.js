/* ── MÓDULO: App — inicialización ── */

/* ── Reloj kiosco ── */
function _actualizarReloj() {
  const now = new Date();
  const te = document.getElementById('kioscoTime');
  const de = document.getElementById('kioscoDate');
  if (te) te.textContent = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (de) de.textContent = now.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
_actualizarReloj();
setInterval(_actualizarReloj, 30000);

/* ── Arranque: sincronizar config y personal desde backend ── */
aplicarEmpresaUI();
setTimeout(sincronizarConfigDesdeBackend, 800);
setTimeout(cargarPersonalDesdeBackend, 1500);

/* ── 5-TAP en logo → Admin ── */
let _tapCount = 0, _tapTimer = null;
document.getElementById('hdrLogo').addEventListener('click', () => {
  _tapCount++;
  if (_tapTimer) clearTimeout(_tapTimer);
  _tapTimer = setTimeout(() => { _tapCount = 0; }, 2000);
  if (_tapCount >= 5) {
    _tapCount = 0; clearTimeout(_tapTimer);
    abrirPinScreen('menu');
  }
});

/* ── Teclado numérico ── */
document.getElementById('teclado').addEventListener('click', e => {
  const t = e.target.closest('.key'); if (!t) return;
  resetIdleTimer();
  const k = t.dataset.k;
  const docInput = document.getElementById('documentoInput');
  if (k === 'C') docInput.value = '';
  else if (k === '⌫') docInput.value = docInput.value.slice(0, -1);
  else if (docInput.value.length < 15) docInput.value += k;
  procesarDoc(docInput.value);
});

/* ── Cola badge click ── */
document.getElementById('colaBadge').addEventListener('click', () => {
  const c = JSON.parse(localStorage.getItem('cola') || '[]');
  if (c.length) showToast(`${c.length} marcación(es) pendientes de enviar`);
});

/* ── Cancelar scan ── */
document.getElementById('btnWkCancel').onclick = () => {
  resetWorker();
  document.getElementById('documentoInput').value = '';
};

/* ── Autorización supervisor desde scan ── */
document.getElementById('btnWkSupAuth').onclick = () => {
  const nombre = WORKER.nombre;
  const tipo = WORKER.tipo;
  if (!nombre || !tipo) return;
  abrirModalSupervisor(
    `<b>${xh(nombre)}</b> — Autorizar marcación de ${tipo} con PIN de supervisor.`,
    () => { ejecutarMarcacion(nombre, tipo, null, true); }
  );
};

/* ── Timer de inactividad (30s → IDLE) ── */
let _idleTimer = null;
const IDLE_TIMEOUT = 30000;

function resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    if (WORKER.state !== 'IDLE' && WORKER.state !== 'CONFIRMED') {
      resetWorker();
      document.getElementById('documentoInput').value = '';
    }
  }, IDLE_TIMEOUT);
}

// Resetear en cualquier interacción
['touchstart', 'mousedown', 'keydown'].forEach(ev => {
  document.addEventListener(ev, resetIdleTimer, {passive: true});
});
resetIdleTimer();

/* ── Service Worker ── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
