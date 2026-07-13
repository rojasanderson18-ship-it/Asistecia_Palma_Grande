/* ── MÓDULO: Asistencia — flujo del trabajador ── */

const WORKER = {
  state: 'IDLE',   // IDLE | SCANNING | VALIDATING | CONFIRMED
  nombre: null,
  tipo: null,
  doc: null,
};
const SCAN_TIMEOUT_MS = 20000;      // 20s sin reconocimiento → error
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000; // 5 min ventana duplicados
const _lastMarked = {};             // { nombre: timestamp }
let _scanTimeoutHandle = null;
let _autoMarkPending = false;

/* ── Estado worker ── */
function setWorkerState(state, data) {
  if (_scanTimeoutHandle) { clearTimeout(_scanTimeoutHandle); _scanTimeoutHandle = null; }
  WORKER.state = state;
  if (data) Object.assign(WORKER, data);
  _renderWorkerState();
}

function _renderWorkerState() {
  const idleBlock = document.getElementById('wkDocBlock');
  const scanBlock = document.getElementById('wkScanBlock');
  const camWrap = document.getElementById('camWrap');
  const valOverlay = document.getElementById('camValidating');

  switch (WORKER.state) {
    case 'IDLE':
      if (idleBlock) idleBlock.style.display = '';
      if (scanBlock) scanBlock.style.display = 'none';
      if (camWrap) camWrap.classList.remove('scanning', 'face-ok');
      _autoMarkPending = false;
      break;

    case 'SCANNING':
      if (idleBlock) idleBlock.style.display = 'none';
      if (scanBlock) scanBlock.style.display = '';
      if (valOverlay) valOverlay.style.display = 'none';
      _updatePersonBanner();
      iniciarCamara();
      // Timeout de escaneo
      _scanTimeoutHandle = setTimeout(() => {
        if (WORKER.state === 'SCANNING') {
          setWorkerState('IDLE');
          showRes('err', 'No se reconoció el rostro',
            'El sistema no pudo identificar tu rostro.',
            ['Mala iluminación', 'Rostro no enrolado', 'Cámara cubierta']);
        }
      }, SCAN_TIMEOUT_MS);
      break;

    case 'VALIDATING':
      if (valOverlay) valOverlay.style.display = 'flex';
      if (camWrap) camWrap.classList.add('face-ok');
      break;
  }
}

function _updatePersonBanner() {
  const av = document.getElementById('wkPersonAv');
  const saludo = document.getElementById('wkPersonSaludo');
  const docEl = document.getElementById('wkPersonDoc');
  const tipoBdg = document.getElementById('wkTipoBdg');
  if (!WORKER.nombre) return;
  if (av) av.textContent = inic(WORKER.nombre);
  if (saludo) saludo.textContent = 'Hola, ' + WORKER.nombre.split(' ')[0] + '!';
  const masked = WORKER.doc ? '••••••' + String(WORKER.doc).slice(-4) : '';
  if (docEl) docEl.textContent = masked;
  if (tipoBdg) tipoBdg.textContent = WORKER.tipo || '';
}

function resetWorker() {
  _autoMarkPending = false;
  setWorkerState('IDLE');
  setConf(0, false);
  // Limpiar doc display
  const docVal = document.getElementById('docVal');
  if (docVal) { docVal.textContent = 'Digite su cédula'; docVal.className = 'doc-number ph'; }
  const docSub = document.getElementById('docSub');
  if (docSub) docSub.style.display = 'none';
  const docChk = document.getElementById('docChk');
  if (docChk) docChk.classList.remove('show');
}

/* ── Lógica de tipo (Entrada/Salida) ── */
async function getTipo(doc) {
  if (!CONFIG.GS_URL || CONFIG.GS_URL.includes('PEGAR')) return {tipo:'Entrada', completo:false, marcas:[]};
  try {
    const r = await fetch(`${CONFIG.GS_URL}?accion=marcasHoy&documento=${encodeURIComponent(doc)}&_=${Date.now()}`, {cache:'no-store'});
    const d = await r.json();
    const m = (d && d.marcas) || [];
    if (m.includes('Salida')) return {tipo:'Salida', completo:true, marcas:m};
    if (m.includes('Entrada')) return {tipo:'Salida', completo:false, marcas:m};
    return {tipo:'Entrada', completo:false, marcas:m};
  } catch {
    const a = new Date(), h = a.getHours() + a.getMinutes() / 60;
    return {tipo: h < (CONFIG.HORARIO.salida || 14.75) ? 'Entrada' : 'Salida', completo:false, marcas:[]};
  }
}

/* ── Puntualidad ── */
function calcularPuntualidad(tipo, hora) {
  const h = hora.getHours() + hora.getMinutes() / 60;
  const GRACIA = 15 / 60;
  const esSabado = hora.getDay() === 6;
  if (tipo === 'Entrada') {
    const entrada = CONFIG.HORARIO.entrada || 6.0;
    if (h <= entrada + GRACIA) return {estado:'ok', msg:'A tiempo', minutos:0};
    const min = Math.round((h - entrada) * 60);
    return {estado:'tarde', msg:`Tarde ${min} min`, minutos:min};
  }
  if (tipo === 'Salida') {
    const salida = esSabado ? (CONFIG.HORARIO.salidaSabado || 11.75) : (CONFIG.HORARIO.salida || 14.75);
    if (h >= salida) return {estado:'ok', msg:'A tiempo', minutos:0};
    const min = Math.round((salida - h) * 60);
    return {estado:'temprano', msg:`Salida ${min} min antes`, minutos:min};
  }
  return {estado:'ok', msg:'', minutos:0};
}

/* ── Marcación ── */
function ejecutarMarcacion(nombre, tipo, confPct, sinBiometria) {
  const hora = new Date();
  const pm = getPorDoc(WORKER.doc || '');
  const punt = calcularPuntualidad(tipo, hora);
  const payload = {
    accion:'marcar', nombre,
    documento: pm ? pm.documento : '',
    finca: CONFIG.FINCA.nombre,
    tipo, cargo: getCargo(nombre),
    fechaHora: hora.toISOString(),
    lat: gpsCoords ? gpsCoords.lat : null,
    lng: gpsCoords ? gpsCoords.lng : null,
    dentroGeocerca: gpsOk,
    distanciaFacial: sinBiometria ? null : (confPct != null ? (1 - confPct / 100) : null),
    sinBiometria: !!sinBiometria,
    puntualidad: punt.estado,
    minutosDeuda: punt.minutos
  };
  enviar(payload);
  updColaBadge();
  saveUltima(nombre, tipo, hora.toLocaleTimeString('es-CO', {hour:'2-digit', minute:'2-digit'}), gpsOk, Date.now());
  setWorkerState('CONFIRMED');
  showConf({
    nombre, documento: pm ? pm.documento : '—',
    tipo, fecha: hora.toLocaleDateString('es-CO', {day:'2-digit', month:'2-digit', year:'numeric'}),
    hora: hora.toLocaleTimeString('es-CO'),
    ubicacion: gpsOk ? 'Dentro del predio' : 'Fuera de geocerca',
    confianza: sinBiometria ? 'Autorizado supervisor' : (confPct != null ? confPct + '%' : '—'),
    finca: CONFIG.FINCA.nombre, gpsOk, sinBiometria, punt
  });
}

/* ── Callback de reconocimiento facial ── */
let _lastFaceMatch = null;
setFaceMatchCallback(function onFaceMatch(nombre, dist) {
  if (_autoMarkPending) return;
  if (WORKER.state !== 'SCANNING') return;

  // Verificar duplicado (5 min)
  const now = Date.now();
  if (_lastMarked[nombre] && now - _lastMarked[nombre] < DUPLICATE_WINDOW_MS) {
    return; // silencioso — sigue escaneando, ya marcó hace poco
  }

  // Verificar que el nombre detectado coincida con el doc ingresado (si hay uno)
  if (WORKER.nombre && WORKER.nombre !== nombre) return;

  _autoMarkPending = true;
  _lastFaceMatch = {nombre, dist};
  setWorkerState('VALIDATING');

  setTimeout(async () => {
    // Si ya no estamos en VALIDATING, alguien canceló
    if (WORKER.state !== 'VALIDATING') { _autoMarkPending = false; return; }

    const confPct = Math.max(0, Math.round((1 - dist) * 100));
    _lastMarked[nombre] = Date.now();

    // Si el worker fue iniciado con un doc específico, usar ese tipo
    let tipo = WORKER.tipo;
    if (!tipo) {
      const p = getPC().find(x => x.nombre === nombre);
      if (p) {
        const res = await getTipo(p.documento);
        if (res.completo) {
          _autoMarkPending = false;
          setWorkerState('IDLE');
          showRes('warn', 'Jornada completa', `<b>${xh(nombre)}</b> ya registró Entrada y Salida hoy.`, []);
          return;
        }
        tipo = res.tipo;
        WORKER.tipo = tipo;
        WORKER.doc = p.documento;
        WORKER.nombre = nombre;
      }
    }

    if (!tipo) { _autoMarkPending = false; setWorkerState('IDLE'); return; }

    // Validar que el descriptor coincida también con alta resolución
    modoActual = 'procesando';
    try {
      const video = document.getElementById('video');
      const det = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({inputSize:320, scoreThreshold:0.5})).withFaceLandmarks().withFaceDescriptor();
      modoActual = null;
      if (!det) {
        _autoMarkPending = false; setWorkerState('SCANNING');
        return;
      }
      const rostros = getRostros();
      const ref = rostros[nombre];
      if (!ref) {
        _autoMarkPending = false; setWorkerState('IDLE');
        // No tiene rostro enrolado — ofrecer autorización supervisor
        abrirModalSupervisor(
          `<b>${xh(nombre)}</b> no tiene rostro enrolado. Un supervisor puede autorizar la marcación con su PIN.`,
          () => ejecutarMarcacion(nombre, tipo, null, true)
        );
        return;
      }
      const finalDist = faceapi.euclideanDistance(det.descriptor, new Float32Array(ref));
      if (finalDist > CONFIG.UMBRAL_FACIAL) {
        _autoMarkPending = false; setWorkerState('SCANNING');
        return;
      }
      const finalPct = Math.max(0, Math.round((1 - finalDist) * 100));
      ejecutarMarcacion(nombre, tipo, finalPct, false);
    } catch {
      modoActual = null;
      _autoMarkPending = false;
      setWorkerState('SCANNING');
    }
  }, 1200);
});

/* ── Entrada por documento ── */
async function procesarDoc(docVal) {
  const docNum = String(docVal).replace(/\D/g, '');
  const docValEl = document.getElementById('docVal');
  const docSubEl = document.getElementById('docSub');
  const docChkEl = document.getElementById('docChk');

  if (!docNum) {
    if (docValEl) { docValEl.textContent = 'Digite su cédula'; docValEl.className = 'doc-number ph'; }
    if (docSubEl) docSubEl.style.display = 'none';
    if (docChkEl) docChkEl.classList.remove('show');
    setWorkerState('IDLE');
    return;
  }

  // Display formateado
  if (docValEl) {
    docValEl.textContent = docNum.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    docValEl.className = 'doc-number';
  }

  const persona = getPorDoc(docNum);
  if (!persona) {
    if (docSubEl) { docSubEl.textContent = 'Documento no encontrado'; docSubEl.className = 'doc-info er'; docSubEl.style.display = 'block'; }
    if (docChkEl) docChkEl.classList.remove('show');
    return;
  }

  if (docSubEl) { docSubEl.textContent = 'Verificando…'; docSubEl.className = 'doc-info'; docSubEl.style.display = 'block'; }
  if (docChkEl) docChkEl.classList.add('show');

  const res = await getTipo(docNum);
  if (res.completo) {
    if (docSubEl) { docSubEl.textContent = 'Ya completaste tu jornada hoy'; docSubEl.className = 'doc-info er'; }
    if (docChkEl) docChkEl.classList.remove('show');
    return;
  }

  if (docSubEl) { docSubEl.textContent = persona.nombre + ' · ' + persona.cargo; docSubEl.className = 'doc-info'; docSubEl.style.display = 'block'; }

  WORKER.nombre = persona.nombre;
  WORKER.tipo = res.tipo;
  WORKER.doc = docNum;
  setWorkerState('SCANNING', {nombre: persona.nombre, tipo: res.tipo, doc: docNum});
}
