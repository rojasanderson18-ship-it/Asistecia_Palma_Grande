/* ── MÓDULO: App — inicialización ── */

/* ── Reloj kiosco — sincronizado al borde del minuto ── */
function _actualizarReloj() {
  const now = new Date();
  const te = document.getElementById('kioscoTime');
  const de = document.getElementById('kioscoDate');
  if (te) te.textContent = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (de) de.textContent = now.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
(function _arrancarReloj() {
  _actualizarReloj();
  const _ahora = new Date();
  const msHastaSiguienteMinuto = (60 - _ahora.getSeconds()) * 1000 - _ahora.getMilliseconds();
  setTimeout(function() {
    _actualizarReloj();
    setInterval(_actualizarReloj, 60000);
  }, msHastaSiguienteMinuto);
})();

/* ── Estado del sistema ── */
function _actualizarSysStatus() {
  const dot = document.getElementById('sysDot');
  const lbl = document.getElementById('sysLabel');
  if (!dot || !lbl) return;
  const netOk = navigator.onLine;
  // Usar gpsEstado explícito en lugar de leer texto del DOM
  const dentroGeocerca = (typeof gpsEstado !== 'undefined') ? gpsEstado === 'DENTRO' : false;
  const buscando       = (typeof gpsEstado !== 'undefined') ? gpsEstado === 'BUSCANDO' : true;

  if (!netOk) {
    dot.className = 'sys-dot warn';
    lbl.textContent = 'Sin conexión — modo offline';
  } else if (buscando) {
    dot.className = 'sys-dot warn';
    lbl.textContent = 'Verificando sistema…';
  } else if (dentroGeocerca || CONFIG.FINCA.lat === 0 && CONFIG.FINCA.lng === 0) {
    dot.className = 'sys-dot';
    lbl.textContent = 'Sistema listo';
  } else {
    dot.className = 'sys-dot warn';
    const estado = typeof gpsEstado !== 'undefined' ? gpsEstado : 'ERROR';
    lbl.textContent = estado === 'SIN_PERMISO'
      ? 'Sin permiso de ubicación'
      : estado === 'NO_DISPONIBLE'
        ? 'GPS no disponible'
        : estado === 'ERROR'
          ? 'Error obteniendo ubicación'
          : 'Fuera del predio';
  }
}
setInterval(_actualizarSysStatus, 3000);
window.addEventListener('online',  _actualizarSysStatus);
window.addEventListener('offline', _actualizarSysStatus);
// Comenzar siempre como "Verificando" — se resolverá cuando GPS responda
setTimeout(_actualizarSysStatus, 500);

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
  const g = document.getElementById('scanIndGps');
  const n = document.getElementById('scanIndRed');
  const dentroGeocerca = (typeof gpsEstado !== 'undefined') ? gpsEstado === 'DENTRO' : false;
  if (g) g.className = 'scan-ind-dot ' + (dentroGeocerca ? 'ok' : 'warn');
  if (n) n.className = 'scan-ind-dot ' + (navigator.onLine ? 'ok' : 'warn');
}
setInterval(_actualizarScanIndicadores, 3000);

/* ── Botón supervisor: visible solo en excepción ── */
function mostrarBtnSupervisor(visible) {
  const btn = document.getElementById('btnWkSupAuth');
  if (btn) btn.style.display = visible ? '' : 'none';
}
window._mostrarBtnSupervisor = mostrarBtnSupervisor;

/* ── Arranque: configuración inicial o kiosco normal ── */
aplicarEmpresaUI();
if (!isAppConfigured()) {
  document.getElementById('setupOverlay').style.display = 'flex';
} else {
  // sincronizarGeocercaPropia() debe ir DESPUÉS de que termine
  // sincronizarConfigDesdeBackend() — si no, la geocerca propia del kiosco
  // quedaría sobreescrita por la configuración compartida.
  setTimeout(async () => {
    await sincronizarConfigDesdeBackend();
    await sincronizarGeocercaPropia();
  }, 800);
  setTimeout(cargarPersonalDesdeBackend, 1500);
  // Restaurar sesión y pantalla admin si el refresh fue durante una sesión activa
  // (sin retraso: se ejecuta antes del primer pintado para evitar parpadeo del teclado)
  const _pantallaGuardada = sessionStorage.getItem('_adm_screen');
  if (_pantallaGuardada && typeof _restaurarSesionAdmin === 'function' && _restaurarSesionAdmin()) {
    // mostrarPantalla() sola NO ejecuta la lógica de carga de cada pantalla
    // (poner la fecha de hoy en Reporte, cargar la lista de Personal, etc.).
    // Sin esto, tras un refresh la pantalla restaurada se veía vacía hasta
    // que algo más disparaba la carga por casualidad (se sentía "lento").
    const _abrirPantallaAdmin = {
      pantallaConfig:          () => { if (typeof abrirConfig === 'function') abrirConfig(); },
      pantallaReporte:         () => {
        mostrarPantalla('pantallaReporte');
        const repFecha = document.getElementById('repFecha');
        if (repFecha && !repFecha.value && typeof fechaLocalISO === 'function') repFecha.value = fechaLocalISO();
        if (typeof cargarReporte === 'function') cargarReporte();
      },
      pantallaEnrolar:         () => { if (typeof _abrirEnrolar === 'function') _abrirEnrolar(); },
      pantallaRostros:         () => { if (typeof abrirGestionRostros === 'function') abrirGestionRostros(); },
      pantallaPersonal:        () => { if (typeof abrirPersonal === 'function') abrirPersonal(); },
      pantallaResetDia:        () => { if (typeof abrirResetDia === 'function') abrirResetDia(); },
      pantallaAgregar:         () => { if (typeof _abrirAgregarPersonal === 'function') _abrirAgregarPersonal(); },
      // Dependen de una persona seleccionada que no se persiste — volver a la lista.
      pantallaFichaPersonal:   () => { if (typeof abrirPersonal === 'function') abrirPersonal(); },
      pantallaFormPersonal:    () => { if (typeof abrirPersonal === 'function') abrirPersonal(); },
      pantallaImportarPersonal:() => { if (typeof abrirPersonal === 'function') abrirPersonal(); },
    };
    const _abrir = _abrirPantallaAdmin[_pantallaGuardada];
    if (_abrir) _abrir(); else mostrarPantalla(_pantallaGuardada);
  }
}
// El atributo data-boot-screen (ver index.html) solo cubre el primer pintado;
// a partir de aquí mostrarPantalla() maneja la navegación con la clase .show.
// Si no se retira, su regla CSS (!important) queda fijando esa pantalla visible
// para siempre, superpuesta con cualquier otra a la que el usuario navegue después.
document.documentElement.removeAttribute('data-boot-screen');

/* ── Logo: solo eliminar title para no exponer hint ── */
const _logoEl = document.getElementById('hdrLogo');
if (_logoEl) _logoEl.removeAttribute('title');

/* ── Botón admin en header ── */
document.getElementById('btnHdrAdmin').addEventListener('click', () => abrirPinScreen('menu'));

/* ══════════════════════════════════════════
   TECLADO — debounce + requestId anticarrera
══════════════════════════════════════════ */
let _docDebounceTimer = null;
let _docRequestId     = 0;   // incrementa con cada tecla; procesarDoc lo ignora si cambió

/* resetDocumentoInicio(): cancela todo y vuelve a estado limpio */
function resetDocumentoInicio() {
  // 1. Invalidar cualquier request en vuelo
  _docRequestId++;
  if (_docDebounceTimer) { clearTimeout(_docDebounceTimer); _docDebounceTimer = null; }

  // 2. Limpiar input
  const docInput = document.getElementById('documentoInput');
  if (docInput) docInput.value = '';

  // 3. Limpiar display
  const dv = document.getElementById('docVal');
  const ds = document.getElementById('docSub');
  const dc = document.getElementById('docChk');
  if (dv) { dv.textContent = 'Digite su cédula'; dv.className = 'doc-number ph'; }
  if (ds) ds.className = 'doc-info doc-info-oculto doc-info-colapsado';
  if (dc) dc.classList.remove('show');

  // 4. Detener cámara si estaba activa y resetear worker
  if (typeof detenerCamara === 'function') detenerCamara();
  if (typeof resetWorker   === 'function') resetWorker();
}

document.getElementById('teclado').addEventListener('click', e => {
  const t = e.target.closest('.key'); if (!t) return;
  // El kiosco no puede estar enrolando a una persona Y escaneando asistencia
  // de otra al mismo tiempo — ambos flujos compiten por la misma cámara.
  if (typeof modoActual !== 'undefined' && modoActual === 'enrolar') return;
  resetIdleTimer();
  const k = t.dataset.k;
  const docInput = document.getElementById('documentoInput');

  if (k === 'C') {
    // C cancela todo inmediatamente
    resetDocumentoInicio();
    return;
  }
  if (k === '⌫') docInput.value = docInput.value.slice(0, -1);
  else if (docInput.value.length < 15) docInput.value += k;

  const val = docInput.value.replace(/\D/g, '');

  // Actualizar display inmediatamente
  const dv = document.getElementById('docVal');
  const ds = document.getElementById('docSub');
  if (dv) {
    if (!val) {
      dv.textContent = 'Digite su cédula';
      dv.className = 'doc-number ph';
    } else {
      dv.textContent = val.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      dv.className = 'doc-number';
      dv.classList.remove('doc-pop'); void dv.offsetWidth; dv.classList.add('doc-pop');
    }
  }
  if (ds) {
    if (!val) {
      ds.className = 'doc-info doc-info-oculto doc-info-colapsado';
    } else {
      // Reservar el espacio desde el primer dígito (aunque el texto real
      // tarde ~300ms en llegar) para que el teclado no salte al aparecer.
      ds.classList.remove('doc-info-colapsado');
    }
  }

  // Si borraron hasta vacío, cancelar todo
  if (!val) { resetDocumentoInicio(); return; }

  // Invalidar request anterior e iniciar debounce de 300ms
  _docRequestId++;
  const myId = _docRequestId;
  if (_docDebounceTimer) clearTimeout(_docDebounceTimer);
  _docDebounceTimer = setTimeout(() => {
    _docDebounceTimer = null;
    // Solo ejecutar si este request sigue siendo el actual
    if (myId === _docRequestId) procesarDoc(docInput.value, myId);
  }, 300);
});

/* ── Cola badge click ── */
document.getElementById('colaBadge').addEventListener('click', () => {
  const c = JSON.parse(localStorage.getItem('cola') || '[]');
  if (c.length) showToast(`${c.length} marcación(es) pendientes de enviar`);
});

/* ── Cancelar scan (Cambiar cédula) ── */
document.getElementById('btnWkCancel').onclick = () => {
  resetDocumentoInicio();
};

/* ── Autorización supervisor desde scan ── */
document.getElementById('btnWkSupAuth').onclick = () => {
  const nombre = WORKER.nombre;
  const tipo   = WORKER.tipo;
  const excep  = WORKER.tipoExcepcion || 'FALLO_RECONOCIMIENTO';
  if (!nombre || !tipo) return;
  abrirModalSupervisor(
    `<b>${xh(nombre)}</b> — Autorizar marcación de ${tipo} con PIN de supervisor.`,
    () => { ejecutarMarcacion(nombre, tipo, null, true, excep); }
  );
};

/* ── Timer de inactividad (30s → IDLE) ── */
let _idleTimer = null;
const IDLE_TIMEOUT = 30000;

function resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    if (WORKER.state !== 'IDLE' && WORKER.state !== 'CONFIRMED') {
      resetDocumentoInicio();
    }
  }, IDLE_TIMEOUT);
}

['touchstart', 'mousedown', 'keydown'].forEach(ev => {
  document.addEventListener(ev, resetIdleTimer, { passive: true });
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
