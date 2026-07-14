/* ── MÓDULO: Asistencia — flujo del trabajador ── */

const WORKER = {
  state: 'IDLE',   // IDLE | SCANNING | VALIDATING | CONFIRMED
  nombre: null,
  tipo: null,
  doc: null,
};
const SCAN_TIMEOUT_MS = 35000;      // 35s sin reconocimiento → error
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

// Cache local de marcas del día: { documento: ['Entrada','Salida',...] }
// Se actualiza cada vez que se hace una marcación exitosa.
function _getMarcasHoyCache() { try { return JSON.parse(localStorage.getItem('marcas_hoy_cache') || '{}'); } catch { return {}; } }
function _setMarcasHoyCache(doc, marcas) {
  const hoy = new Date().toISOString().slice(0, 10);
  const stored = _getMarcasHoyCache();
  // Invalidar si cambió el día
  if (stored._fecha !== hoy) { localStorage.setItem('marcas_hoy_cache', JSON.stringify({ _fecha: hoy })); }
  const fresh = _getMarcasHoyCache();
  fresh[doc] = marcas;
  localStorage.setItem('marcas_hoy_cache', JSON.stringify(fresh));
}
function _agregarMarcaLocal(doc, tipo) {
  const cache = _getMarcasHoyCache();
  const hoy = new Date().toISOString().slice(0, 10);
  if (cache._fecha !== hoy) { localStorage.setItem('marcas_hoy_cache', JSON.stringify({ _fecha: hoy })); }
  const fresh = _getMarcasHoyCache();
  if (!fresh[doc]) fresh[doc] = [];
  if (!fresh[doc].includes(tipo)) fresh[doc].push(tipo);
  localStorage.setItem('marcas_hoy_cache', JSON.stringify(fresh));
}

// Revisión de la cola offline: ¿hay marcaciones pendientes para este doc hoy?
function _marcasPendientesEnCola(doc) {
  const hoy = new Date().toISOString().slice(0, 10);
  const cola = JSON.parse(localStorage.getItem('cola') || '[]');
  return cola
    .filter(m => String(m.documento) === String(doc) && m.fechaHora && m.fechaHora.startsWith(hoy))
    .map(m => m.tipo);
}

async function getTipo(doc) {
  const hoy = new Date().toISOString().slice(0, 10);

  // 1. Cache local del día (marcaciones ya confirmadas en esta sesión)
  const cacheHoy = _getMarcasHoyCache();
  let marcasConocidas = (cacheHoy._fecha === hoy && cacheHoy[doc]) ? [...cacheHoy[doc]] : [];

  // 2. Cola offline pendiente (marcaciones aun no enviadas al backend)
  const pendientes = _marcasPendientesEnCola(doc);
  pendientes.forEach(t => { if (!marcasConocidas.includes(t)) marcasConocidas.push(t); });

  // 3. Si ya conocemos el estado completo localmente, usarlo sin red
  if (marcasConocidas.includes('Salida')) return { tipo: 'Salida', completo: true, marcas: marcasConocidas };
  if (marcasConocidas.includes('Entrada')) return { tipo: 'Salida', completo: false, marcas: marcasConocidas };

  // 4. Consultar backend si hay URL configurada y deviceToken disponible
  const deviceTok = (typeof getDeviceToken === 'function') ? getDeviceToken() : null;
  if (CONFIG.GS_URL && deviceTok) {
    try {
      const deviceDid = (typeof getDeviceId === 'function') ? getDeviceId() : null;
      const r = await fetch(CONFIG.GS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ accion: 'marcasHoy', deviceToken: deviceTok, deviceId: deviceDid, documento: doc }),
      });
      const d = await r.json();
      const m = (d && d.marcas) ? d.marcas : [];
      if (m.length) _setMarcasHoyCache(doc, m);
      if (m.includes('Salida')) return { tipo: 'Salida', completo: true, marcas: m };
      if (m.includes('Entrada')) return { tipo: 'Salida', completo: false, marcas: m };
      return { tipo: 'Entrada', completo: false, marcas: m };
    } catch {
      // Backend no disponible: caer en error explícito
    }
  }

  // Sin estado local ni backend: no asumir el tipo — pedir verificación
  // La hora NUNCA determina Entrada o Salida
  return { tipo: null, completo: false, marcas: [], sinEstado: true };
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

/* ── Verificación local: ¿la marcación requeriría supervisión que no puede encolarse offline? ──
 * El token de supervisor dura 5 min y habrá expirado antes de que la cola sincronice.
 * Bloquear cuando: sinBiometria, GPS ausente/baja precisión con geocerca, fuera de geocerca.
 */
function _requiereSupervisorLocal(sinBiometria) {
  if (sinBiometria) return true;
  const geocercaLocal = CONFIG.FINCA.lat !== 0 && CONFIG.FINCA.lng !== 0;
  if (!geocercaLocal) return false;
  if (!gpsCoords) return true;                           // sin GPS y hay geocerca
  if (!gpsOk) return true;                              // fuera de geocerca
  // precision null o >100 m con geocerca configurada: backend exigiría supervisor
  const prec = gpsCoords.precision;
  if (prec == null || prec > 100) return true;
  return false;
}

const _MSG_REQUIERE_CONEXION = 'Esta marcación excepcional requiere conexión para ser autorizada por el supervisor.';

/* ── Marcación ── */
async function ejecutarMarcacion(nombre, tipo, confPct, sinBiometria) {
  const hora = new Date();
  const doc  = WORKER.doc ? String(WORKER.doc).trim() : '';
  if (!doc) {
    setWorkerState('IDLE');
    showRes('err', 'Sin documento', 'No se puede registrar sin número de documento.', ['Reingresa la cédula e intenta nuevamente']);
    return;
  }

  const punt = calcularPuntualidad(tipo, hora);
  const payload = {
    accion: 'marcar',
    documento: doc,
    tipo,
    fechaHora: hora.toISOString(),
    lat: gpsCoords ? gpsCoords.lat : null,
    lng: gpsCoords ? gpsCoords.lng : null,
    precisionGPS: gpsCoords ? gpsCoords.precision : null,
    distanciaFacial: sinBiometria ? null : (confPct != null ? (1 - confPct / 100) : null),
    sinBiometria: !!sinBiometria,
    supervisorToken: (typeof getSupervisorToken === 'function') ? getSupervisorToken() : null,
    sinConexion: false,
  };

  const horaStr = hora.toLocaleTimeString('es-CO', {hour:'2-digit', minute:'2-digit'});

  /* ── MODO OFFLINE: solo encolar si no requiere supervisor ── */
  if (!navigator.onLine || !CONFIG.GS_URL) {
    if (_requiereSupervisorLocal(sinBiometria)) {
      setWorkerState('IDLE');
      showRes('warn', 'Conexión requerida', _MSG_REQUIERE_CONEXION,
        ['Activa la conexión a internet e intenta nuevamente']);
      return;
    }
    payload.sinConexion = true;
    _encolarOfflineConMeta(payload);
    updColaBadge();
    _agregarMarcaLocal(doc, tipo);
    saveUltima(nombre, tipo, horaStr, gpsOk, Date.now());
    setWorkerState('CONFIRMED');
    showConf({ nombre, tipo, hora: horaStr, gpsOk, sinBiometria, punt, offline: true });
    return;
  }

  /* ── MODO ONLINE: esperar respuesta del servidor ── */
  let r;
  try {
    r = await enviarConResp(payload);
  } catch {
    r = null;
  }

  /* Error de red real → encolar solo si no requiere supervisor */
  if (!r || r.networkError) {
    if (_requiereSupervisorLocal(sinBiometria)) {
      setWorkerState('IDLE');
      showRes('warn', 'Conexión requerida', _MSG_REQUIERE_CONEXION,
        ['Verifica la conexión a internet e intenta nuevamente']);
      return;
    }
    payload.sinConexion = true;
    _encolarOfflineConMeta(payload);
    updColaBadge();
    _agregarMarcaLocal(doc, tipo);
    saveUltima(nombre, tipo, horaStr, gpsOk, Date.now());
    setWorkerState('CONFIRMED');
    showConf({ nombre, tipo, hora: horaStr, gpsOk, sinBiometria, punt, offline: true });
    return;
  }

  /* Fuera de geocerca o GPS ausente → abrir modal supervisor si aún no hay token */
  if (r.fueraGeocerca) {
    const tieneSupervisorToken = !!(typeof getSupervisorToken === 'function' && getSupervisorToken());
    if (tieneSupervisorToken) {
      if (typeof clearSupervisorToken === 'function') clearSupervisorToken();
      setWorkerState('IDLE');
      const det = r.gpsAusente
        ? 'GPS no disponible. Supervisor no autorizado.'
        : `${r.distanciaMetros != null ? 'A ' + r.distanciaMetros + ' m del predio. ' : ''}Supervisor no autorizado.`;
      showRes('err', r.gpsAusente ? 'Sin señal GPS' : 'Fuera de la geocerca', det,
        ['PIN de supervisor incorrecto o expirado']);
    } else {
      const msg = r.gpsAusente
        ? `GPS no disponible para <b>${xh(nombre)}</b>. Autorizar con PIN de supervisor.`
        : `<b>${xh(nombre)}</b> está fuera del predio${r.distanciaMetros != null ? ' (' + r.distanciaMetros + ' m)' : ''}. Autorizar con PIN de supervisor.`;
      abrirModalSupervisor(msg, () => ejecutarMarcacion(nombre, tipo, confPct, sinBiometria));
    }
    return;
  }

  /* Servidor rechazó la marcación (secuencia, empleado inexistente, etc.) */
  if (!r.ok) {
    setWorkerState('IDLE');
    showRes('err', 'Marcación no registrada', r.error || 'El servidor rechazó la marcación.', []);
    return;
  }

  /* ── ÉXITO CONFIRMADO POR SERVIDOR ── */
  _agregarMarcaLocal(doc, tipo);
  const horaServidor = r.horaServidor || horaStr;
  saveUltima(r.nombre || nombre, tipo, horaServidor, r.dentroGeocerca, Date.now());
  setWorkerState('CONFIRMED');
  showConf({
    nombre: r.nombre || nombre, tipo,
    hora: horaServidor, gpsOk: r.dentroGeocerca, sinBiometria, punt, offline: false
  });
}

/* Encola un item con metadatos de reintento */
function _encolarOfflineConMeta(payload) {
  const c = JSON.parse(localStorage.getItem('cola') || '[]');
  c.push({ ...payload, _meta: { intentos: 0, ultimoIntento: null, ultimoError: null, estado: 'pendiente' } });
  localStorage.setItem('cola', JSON.stringify(c));
}

/* ── Callback de reconocimiento facial ──
   Recibe 2 coincidencias consecutivas ya validadas por face-recognition.js.
   No hay setTimeout fijo ni segunda detección independiente.
── */
let _lastFaceMatch = null;
setFaceMatchCallback(async function onFaceMatch(nombre, dist) {
  if (_autoMarkPending) return;
  if (WORKER.state !== 'SCANNING') return;

  // Ventana anti-duplicado (5 min)
  const now = Date.now();
  if (_lastMarked[nombre] && now - _lastMarked[nombre] < DUPLICATE_WINDOW_MS) return;

  // Filtrar si hay doc ingresado y no coincide
  if (WORKER.nombre && WORKER.nombre !== nombre) return;

  _autoMarkPending = true;
  _lastFaceMatch = { nombre, dist };
  setWorkerState('VALIDATING');

  const tMatch = Date.now();

  if (WORKER.state !== 'VALIDATING') { _autoMarkPending = false; return; }

  const confPct = Math.max(0, Math.round((1 - dist) * 100));
  _lastMarked[nombre] = Date.now();

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

  // Verificar que el trabajador tenga rostro enrolado
  const rostros = getRostros();
  if (!rostros[nombre]) {
    _autoMarkPending = false; setWorkerState('IDLE');
    abrirModalSupervisor(
      `<b>${xh(nombre)}</b> no tiene rostro enrolado. Un supervisor puede autorizar la marcación con su PIN.`,
      () => ejecutarMarcacion(nombre, tipo, null, true)
    );
    return;
  }

  // Registrar métrica de velocidad
  if (typeof registrarMetrica === 'function') {
    registrarMetrica({ evento: 'reconocimiento', nombre: nombre.slice(0, 3) + '***', dist: dist.toFixed(3), msHastaMatch: Date.now() - tMatch, confPct });
  }

  await ejecutarMarcacion(nombre, tipo, confPct, false);
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

  // Sin estado conocido y sin conexión: no avanzar, informar al operario
  if (res.sinEstado) {
    if (docSubEl) { docSubEl.textContent = 'Sin conexión — activa el internet para verificar marcaciones'; docSubEl.className = 'doc-info er'; docSubEl.style.display = 'block'; }
    if (docChkEl) docChkEl.classList.remove('show');
    return;
  }

  if (docSubEl) { docSubEl.textContent = persona.nombre + ' · ' + persona.cargo; docSubEl.className = 'doc-info'; docSubEl.style.display = 'block'; }

  WORKER.nombre = persona.nombre;
  WORKER.tipo = res.tipo;
  WORKER.doc = docNum;
  setWorkerState('SCANNING', {nombre: persona.nombre, tipo: res.tipo, doc: docNum});
}
