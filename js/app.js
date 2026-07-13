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

/* ── Estado del sistema (línea discreta) ── */
function _actualizarSysStatus() {
  const dot = document.getElementById('sysDot');
  const lbl = document.getElementById('sysLabel');
  if (!dot || !lbl) return;
  const geoOk  = (document.getElementById('stGeocerca')?.textContent || '').includes('OK');
  const gpsOkT = (document.getElementById('stUbicacion')?.textContent || '').includes('Dentro');
  const netOk  = navigator.onLine;
  if (!netOk) {
    dot.className = 'sys-dot warn';
    lbl.textContent = 'Sin conexión — modo offline';
  } else if (!geoOk || !gpsOkT) {
    dot.className = 'sys-dot warn';
    lbl.textContent = 'Fuera del predio';
  } else {
    dot.className = 'sys-dot';
    lbl.textContent = 'Sistema listo';
  }
}
setInterval(_actualizarSysStatus, 5000);
window.addEventListener('online',  _actualizarSysStatus);
window.addEventListener('offline', _actualizarSysStatus);
setTimeout(_actualizarSysStatus, 2000);

/* ── Toggle detalle sistema ── */
function toggleSysDetail() {
  const det  = document.getElementById('sysDetail');
  const chev = document.getElementById('sysChevron');
  if (!det) return;
  const open = det.classList.toggle('open');
  if (chev) chev.classList.toggle('open', open);
}

/* ── Indicadores pantalla scan ── */
function _actualizarScanIndicadores() {
  const r = document.getElementById('scanIndRostro');
  const g = document.getElementById('scanIndGps');
  const n = document.getElementById('scanIndRed');
  if (!r) return;
  // Rostro: lo actualiza face-recognition.js via confFill/confPct — aquí solo red y gps
  const geoTxt = document.getElementById('stGeocerca')?.textContent || '';
  const gpsOn  = (document.getElementById('stUbicacion')?.textContent || '').includes('Dentro');
  if (g) g.className = 'scan-ind-dot ' + (gpsOn ? 'ok' : 'warn');
  if (n) n.className = 'scan-ind-dot ' + (navigator.onLine ? 'ok' : 'warn');
}
setInterval(_actualizarScanIndicadores, 3000);

/* ── Botón supervisor: visible solo en excepción ── */
function mostrarBtnSupervisor(visible) {
  const btn = document.getElementById('btnWkSupAuth');
  if (btn) btn.style.display = visible ? '' : 'none';
}
window._mostrarBtnSupervisor = mostrarBtnSupervisor;

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
  const _dv = document.getElementById('docVal');
  if (_dv) { _dv.classList.remove('doc-pop'); void _dv.offsetWidth; _dv.classList.add('doc-pop'); }
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

/* ── Animación slide-in al mostrar bloque scan ── */
(function() {
  const block = document.getElementById('wkScanBlock');
  if (!block) return;
  let _wasHidden = true;
  new MutationObserver(() => {
    const hidden = block.style.display === 'none' || block.style.display === '';
    if (_wasHidden && !hidden) {
      block.classList.remove('anim-slide-in');
      void block.offsetWidth;
      block.classList.add('anim-slide-in');
      setTimeout(() => block.classList.remove('anim-slide-in'), 280);
    }
    _wasHidden = hidden;
  }).observe(block, { attributes: true, attributeFilter: ['style'] });
})();

/* ── Service Worker ── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
