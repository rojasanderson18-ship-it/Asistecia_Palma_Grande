/* ── MÓDULO: UI / Pantallas ── */

const _PANTALLAS_ADMIN = new Set([
  'pantallaMenu','pantallaConfig','pantallaReporte','pantallaEnrolar',
  'pantallaRostros','pantallaPersonal','pantallaAgregar','pantallaResetDia',
  'pantallaFichaPersonal','pantallaFormPersonal','pantallaImportarPersonal',
]);

function mostrarPantalla(id) {
  document.querySelectorAll('.pantalla').forEach(p => p.classList.remove('show'));
  const target = document.getElementById(id);
  if (target) target.classList.add('show');
  if (id === 'pantallaMenu') actualizarMenuAdmin();
  // Persistir pantalla admin para restaurar tras refresh
  if (_PANTALLAS_ADMIN.has(id)) {
    sessionStorage.setItem('_adm_screen', id);
  } else {
    sessionStorage.removeItem('_adm_screen');
  }
}

/* Reloj */
function tickReloj() {
  const a = new Date();
  const h = a.getHours() % 12 || 12;
  const m = String(a.getMinutes()).padStart(2, '0');
  const s = String(a.getSeconds()).padStart(2, '0');
  const el = document.getElementById('stHora');
  if (el) el.textContent = `${h}:${m}:${s} ${a.getHours() >= 12 ? 'p.m.' : 'a.m.'}`;
}
setInterval(tickReloj, 1000);
tickReloj();

/* ── CONFIRMACIÓN INMERSIVA ── */
let _cdInterval = null;
function showConf(d) {
  playSound('success');
  if (navigator.vibrate) navigator.vibrate([200, 50, 200]);

  const primerNombre = d.nombre.split(' ')[0];
  const esEntrada = d.tipo === 'Entrada';
  const bg = esEntrada ? '#061410' : '#08091A';
  const ico = esEntrada
    ? `<svg class="conf-ico-chk" viewBox="0 0 64 64" fill="none">
        <circle cx="32" cy="32" r="32" fill="rgba(74,222,128,0.10)"/>
        <polyline points="16 32 27 43 48 20" stroke="#4ADE80" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
       </svg>`
    : `<div class="conf-ico-wave">👋</div>`;

  let alerts = '';
  if (d.offline) alerts += `<div class="conf-alert fuera">📶 Marcación guardada en el dispositivo · Pendiente de sincronización</div>`;
  if (!d.gpsOk) alerts += `<div class="conf-alert fuera">⚠ Fuera del predio — revisar con Gerencia</div>`;
  if (d.punt && d.punt.estado === 'tarde') alerts += `<div class="conf-alert tarde">⏰ Entrada tarde — debe ${d.punt.minutos} min</div>`;
  if (d.punt && d.punt.estado === 'temprano') alerts += `<div class="conf-alert temprano">⏰ Salida anticipada — debe ${d.punt.minutos} min</div>`;
  if (d.sinBiometria) alerts += `<div class="conf-alert supervisor">👤 Autorizado por supervisor</div>`;

  document.getElementById('resultadoContenido').innerHTML = `
    <div class="conf-full" style="background:${bg}">
      <div class="conf-ico">${ico}</div>
      <div class="conf-saludo">${esEntrada ? 'BIENVENIDO' : 'HASTA PRONTO'}</div>
      <div class="conf-nombre">${xh(primerNombre)}</div>
      <div class="conf-subtipo">${xh(d.tipo)} registrada · ${d.hora}</div>
      ${alerts ? `<div class="conf-alerts">${alerts}</div>` : ''}
      <div class="conf-pgbar-wrap"><div class="conf-pgbar" id="confPBar" style="width:100%"></div></div>
    </div>`;

  mostrarPantalla('pantallaResultado');

  setTimeout(() => {
    const bar = document.getElementById('confPBar');
    if (bar) bar.style.width = '0%';
  }, 60);

  function volverInicio() {
    if (_cdInterval) clearInterval(_cdInterval);
    _cdInterval = null;
    const camWrap = document.getElementById('camWrap');
    if (camWrap) camWrap.classList.remove('scanning', 'face-ok');
    // resetDocumentoInicio() limpia también el valor real de #documentoInput
    // (resetWorker() por sí solo solo restaura el texto visible, dejando los
    // dígitos viejos pegados por debajo para la siguiente cédula digitada).
    if (typeof resetDocumentoInicio === 'function') resetDocumentoInicio();
    else if (typeof resetWorker === 'function') resetWorker();
    mostrarPantalla('pantallaMarcacion');
  }

  if (_cdInterval) clearInterval(_cdInterval);
  let secs = 3;
  _cdInterval = setInterval(() => { secs--; if (secs <= 0) { clearInterval(_cdInterval); _cdInterval = null; volverInicio(); } }, 1000);
}

/* ── RESULTADO ERROR/WARN INMERSIVO ── */
function showRes(tipo, tit, det, causas) {
  if (tipo === 'err') playSound('error');
  const isErr = tipo === 'err', isWarn = tipo === 'warn';
  const wrapClass = isErr ? 'err-full' : isWarn ? 'warn-full' : 'conf-full';
  const ringClass = isErr ? 'err-ring' : isWarn ? 'warn-ring' : 'conf-ring';
  const strokeColor = isErr ? '#FF5252' : isWarn ? '#FFAB40' : '#4ADE80';
  const icoPath = isErr ? '<path d="M18 6L6 18M6 6l12 12"/>' : isWarn ? '<path d="M12 9v4M12 17h.01"/>' : '<polyline points="20 6 9 17 4 12"/>';
  const causasHtml = Array.isArray(causas) && causas.length
    ? `<div style="background:rgba(255,255,255,.05);border-radius:12px;padding:12px 16px;margin-bottom:20px;max-width:280px;width:100%;text-align:left;">
        <div style="font-size:11px;font-weight:800;color:rgba(255,255,255,.3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">Posibles causas</div>
        <ul style="margin-left:14px;">${causas.map(c => `<li style="font-size:12px;color:rgba(255,255,255,.45);margin-bottom:4px;">${xh(c)}</li>`).join('')}</ul>
       </div>` : '';

  function goBack() {
    const camWrap = document.getElementById('camWrap');
    if (camWrap) camWrap.classList.remove('scanning', 'face-ok');
    // resetDocumentoInicio() limpia también el valor real de #documentoInput
    // (resetWorker() por sí solo solo restaura el texto visible, dejando los
    // dígitos viejos pegados por debajo para la siguiente cédula digitada).
    if (typeof resetDocumentoInicio === 'function') resetDocumentoInicio();
    else if (typeof resetWorker === 'function') resetWorker();
    mostrarPantalla('pantallaMarcacion');
  }

  document.getElementById('resultadoContenido').innerHTML = `
    <div class="${wrapClass}">
      <div class="${ringClass}">
        <svg viewBox="0 0 24 24" fill="none" stroke="${strokeColor}" stroke-width="2.8" width="36" height="36">${icoPath}</svg>
      </div>
      <div class="err-tit">${tit}</div>
      <div class="err-sub">${det || ''}</div>
      ${causasHtml}
      <div class="err-actions">
        <button class="err-btn-main" id="resBtn1">Intentar nuevamente</button>
        <button class="err-btn-sec" id="resBtn2">Volver al inicio</button>
      </div>
    </div>`;

  mostrarPantalla('pantallaResultado');
  document.getElementById('resBtn1').onclick = goBack;
  document.getElementById('resBtn2').onclick = goBack;
  if (tipo !== 'ok') setTimeout(goBack, 8000);
}

/* ── MODAL GENÉRICO (reemplaza alert/confirm nativos) ── */
let _mgenResolve = null;

document.getElementById('mgenOk').addEventListener('click', () => {
  document.getElementById('modalGen').style.display = 'none';
  if (_mgenResolve) { _mgenResolve(true); _mgenResolve = null; }
});
document.getElementById('mgenCancel').addEventListener('click', () => {
  document.getElementById('modalGen').style.display = 'none';
  if (_mgenResolve) { _mgenResolve(false); _mgenResolve = null; }
});

/* Pide una contraseña (para cifrar/descifrar respaldos) reutilizando el
   modal genérico — inyecta un <input type="password"> sobre los botones. */
function askPassword(msg, okText) {
  return new Promise(resolve => {
    document.getElementById('mgenMsg').textContent = msg;
    let inp = document.getElementById('mgenPass');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'password';
      inp.id = 'mgenPass';
      inp.autocomplete = 'off';
      inp.style.cssText = 'width:100%;box-sizing:border-box;margin:10px 0 2px;padding:10px 12px;border-radius:10px;border:1px solid var(--bd);font-size:14px;';
      document.getElementById('mgenMsg').insertAdjacentElement('afterend', inp);
    }
    inp.value = '';
    inp.style.display = '';
    document.getElementById('mgenCancel').style.display = '';
    document.getElementById('mgenCancel').textContent = 'Cancelar';
    document.getElementById('mgenOk').textContent = okText || 'Continuar';
    document.getElementById('mgenOk').className = 'mgen-ok';
    document.getElementById('modalGen').style.display = 'flex';
    setTimeout(() => inp.focus(), 60);
    _mgenResolve = (ok) => {
      inp.style.display = 'none';
      resolve(ok ? inp.value : null);
    };
  });
}

function showAlert(msg) {
  return new Promise(resolve => {
    _mgenResolve = () => resolve();
    document.getElementById('mgenMsg').textContent = msg;
    document.getElementById('mgenCancel').style.display = 'none';
    document.getElementById('mgenOk').textContent = 'Aceptar';
    document.getElementById('mgenOk').className = 'mgen-ok';
    document.getElementById('modalGen').style.display = 'flex';
  });
}

function showConfirm(msg, okText, danger) {
  return new Promise(resolve => {
    _mgenResolve = resolve;
    document.getElementById('mgenMsg').textContent = msg;
    document.getElementById('mgenCancel').style.display = '';
    document.getElementById('mgenCancel').textContent = 'Cancelar';
    document.getElementById('mgenOk').textContent = okText || 'Confirmar';
    document.getElementById('mgenOk').className = 'mgen-ok' + (danger ? ' danger' : '');
    document.getElementById('modalGen').style.display = 'flex';
  });
}

// Diálogo de dos opciones sin cancelar: okText = opción A (true), cancelText = opción B (false)
function showChoice(msg, okText, cancelText) {
  return new Promise(resolve => {
    _mgenResolve = resolve;
    document.getElementById('mgenMsg').textContent = msg;
    document.getElementById('mgenCancel').style.display = '';
    document.getElementById('mgenCancel').textContent = cancelText || 'No';
    document.getElementById('mgenOk').textContent = okText || 'Sí';
    document.getElementById('mgenOk').className = 'mgen-ok';
    document.getElementById('modalGen').style.display = 'flex';
  });
}

/* ── TOAST ── */
const _toastEl = document.createElement('div');
_toastEl.className = 'toast';
document.body.appendChild(_toastEl);
let _toastTimer = null;
function showToast(msg) {
  _toastEl.textContent = msg;
  _toastEl.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => _toastEl.classList.remove('show'), 2500);
}

/* ── MODAL SUPERVISOR ── */
let _modalOkCb = null;
function abrirModalSupervisor(txt, cb) {
  _modalOkCb = cb;
  const txtEl = document.getElementById('modalSupervisorTxt');
  const pinEl = document.getElementById('modalPinInput');
  const errEl = document.getElementById('modalPinErr');
  const modal = document.getElementById('modalSupervisor');
  if (txtEl) txtEl.innerHTML = txt;
  if (pinEl) pinEl.value = '';
  if (errEl) errEl.textContent = '';
  if (modal) modal.style.display = 'flex';
  setTimeout(() => { if (pinEl) pinEl.focus(); }, 100);
}

document.getElementById('modalPinOk').onclick = async () => {
  const btn = document.getElementById('modalPinOk');
  const pin = document.getElementById('modalPinInput').value;
  const errEl = document.getElementById('modalPinErr');
  btn.disabled = true;
  const result = await loginSupervisor(pin);
  btn.disabled = false;
  if (!result.ok) {
    if (errEl) errEl.textContent = result.error || 'PIN incorrecto';
    return;
  }
  document.getElementById('modalSupervisor').style.display = 'none';
  if (_modalOkCb) { _modalOkCb(); _modalOkCb = null; }
  clearSupervisorToken();
};

document.getElementById('modalPinCancel').onclick = () => {
  document.getElementById('modalSupervisor').style.display = 'none';
  _modalOkCb = null;
};

/* Última marcación */
function fmtHace(ts) {
  const d = Date.now() - ts, m = Math.floor(d / 60000), h = Math.floor(m / 60), mn = m % 60;
  if (h > 0) return `Hace ${h}h ${mn}m`;
  return `Hace ${m}m`;
}
function saveUltima(nombre, tipo, hora, dentro, ts) {
  localStorage.setItem('ultima_marc', JSON.stringify({nombre, tipo, hora, dentro, ts}));
  showUltima();
}
function showUltima() {
  const d = JSON.parse(localStorage.getItem('ultima_marc') || 'null');
  const s = document.getElementById('ultimaSection');
  if (!d || !s) return;
  // Si la persona ya no existe en el personal activo (eliminada o inactivada),
  // no dejar su última marcación pegada indefinidamente en la pantalla.
  const existe = (typeof getPC === 'function') ? getPC().some(p => p.nombre === d.nombre) : true;
  if (!existe) { s.style.display = 'none'; return; }
  s.style.display = 'block';
  document.getElementById('ulNombre').textContent = d.nombre || '—';
  document.getElementById('ulInic').textContent = inic(d.nombre || '');
  const tag = document.getElementById('ulTipo');
  tag.textContent = d.tipo;
  tag.className = 'ul-tag' + (d.tipo === 'Salida' ? ' salida' : '');
  document.getElementById('ulHora').textContent = d.hora;
  document.getElementById('ulHace').textContent = fmtHace(d.ts);
}
showUltima();
setInterval(() => {
  const d = JSON.parse(localStorage.getItem('ultima_marc') || 'null');
  if (d) { const el = document.getElementById('ulHace'); if (el) el.textContent = fmtHace(d.ts); }
}, 60000);
