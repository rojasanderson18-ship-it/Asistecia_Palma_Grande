/* ── MÓDULO: Asistencia — flujo del trabajador ── */

/* ── Fecha local Colombia (evita desfase UTC después de las 7 p.m.) ── */
function fechaLocalISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

const WORKER = {
  state: 'IDLE',       // IDLE | SCANNING | VALIDATING | CONFIRMED
  nombre: null,
  tipo: null,
  doc: null,
  tScanInicio: null,   // timestamp al entrar a SCANNING (para métricas)
  tipoExcepcion: null, // excepción activa cuando se abre modal de supervisor
};
const SCAN_TIMEOUT_MS     = 20000;
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const _lastMarked = {};  // { nombre: timestamp } — solo se asigna en éxito confirmado

let _scanHintHandle    = null;
let _scanTimeoutHandle = null;
let _autoMarkPending   = false;

function _cancelarTimersScan() {
  if (_scanHintHandle)    { clearTimeout(_scanHintHandle);    _scanHintHandle    = null; }
  if (_scanTimeoutHandle) { clearTimeout(_scanTimeoutHandle); _scanTimeoutHandle = null; }
}

/* ── ID único por marcación (idempotencia) ── */
function _generarMarcacionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

/* ── Distancia GPS (haversine) ── */
function _distanciaGPS(lat1, lng1, lat2, lng2) {
  const R = 6371000, tr = x => x * Math.PI / 180;
  const dLa = tr(lat2 - lat1), dLo = tr(lng2 - lng1);
  const a = Math.sin(dLa/2)**2 + Math.cos(tr(lat1)) * Math.cos(tr(lat2)) * Math.sin(dLo/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── Texto del motivo de excepción ── */
function _motivoDesdeExcepcion(tipo) {
  const MOTIVOS = {
    FUERA_GEOCERCA:       'Trabajador fuera del predio',
    GPS_AUSENTE:          'GPS no disponible',
    GPS_IMPRECISO:        'GPS con baja precisión',
    SIN_BIOMETRIA:        'Sin biometría registrada',
    FALLO_RECONOCIMIENTO: 'Fallo de reconocimiento facial',
  };
  return MOTIVOS[tipo] || tipo || 'Excepción manual';
}

/* ── Estado worker ── */
function setWorkerState(state, data) {
  _cancelarTimersScan();
  WORKER.state = state;
  if (data) Object.assign(WORKER, data);
  _renderWorkerState();
}

function _renderWorkerState() {
  const idleBlock = document.getElementById('wkDocBlock');
  const scanBlock = document.getElementById('wkScanBlock');
  const camWrap   = document.getElementById('camWrap');
  const valOverlay = document.getElementById('camValidating');

  switch (WORKER.state) {
    case 'IDLE':
      if (idleBlock) idleBlock.style.display = '';
      if (scanBlock) scanBlock.style.display = 'none';
      if (camWrap) camWrap.classList.remove('scanning', 'face-ok');
      _autoMarkPending = false;
      if (typeof detenerCamara === 'function') detenerCamara();
      break;

    case 'SCANNING':
      if (idleBlock) idleBlock.style.display = 'none';
      if (scanBlock) scanBlock.style.display = '';
      if (valOverlay) valOverlay.style.display = 'none';
      _updatePersonBanner();
      WORKER.tScanInicio = Date.now();
      iniciarCamara();
      // A los 8s: pista visual
      _scanHintHandle = setTimeout(() => {
        if (WORKER.state === 'SCANNING') {
          if (typeof _setCamEstado === 'function') {
            _setCamEstado('Acérquese un poco · mire directamente a la cámara · mejore la iluminación.');
          }
        }
      }, 8000);
      // A los 20s: error con alternativa de supervisor
      _scanTimeoutHandle = setTimeout(() => {
        if (WORKER.state === 'SCANNING') {
          const nombre = WORKER.nombre;
          const tipo   = WORKER.tipo;
          WORKER.tipoExcepcion = 'FALLO_RECONOCIMIENTO';
          setWorkerState('IDLE');
          if (nombre && tipo) {
            abrirModalSupervisor(
              `No se reconoció el rostro de <b>${xh(nombre)}</b>. Un supervisor puede autorizar la marcación con su PIN.`,
              () => ejecutarMarcacion(nombre, tipo, null, true, 'FALLO_RECONOCIMIENTO')
            );
          } else {
            showRes('err', 'No se reconoció el rostro',
              'El sistema no pudo identificar su rostro.',
              ['Acérquese un poco', 'Mire directamente a la cámara', 'Mejore la iluminación', 'Solicite autorización al supervisor']);
          }
        }
      }, SCAN_TIMEOUT_MS);
      break;

    case 'VALIDATING':
      if (valOverlay) valOverlay.style.display = 'flex';
      if (camWrap) camWrap.classList.add('face-ok');
      break;

    case 'CONFIRMED':
      if (typeof detenerCamara === 'function') detenerCamara();
      break;
  }
}

function _updatePersonBanner() {
  const av      = document.getElementById('wkPersonAv');
  const saludo  = document.getElementById('wkPersonSaludo');
  const docEl   = document.getElementById('wkPersonDoc');
  const tipoBdg = document.getElementById('wkTipoBdg');
  if (!WORKER.nombre) return;
  if (av)      av.textContent     = inic(WORKER.nombre);
  if (saludo)  saludo.textContent = 'Hola, ' + WORKER.nombre.split(' ')[0] + '!';
  const masked = WORKER.doc ? '••••••' + String(WORKER.doc).slice(-4) : '';
  if (docEl)   docEl.textContent  = masked;
  if (tipoBdg) tipoBdg.textContent = WORKER.tipo || '';
}

function resetWorker() {
  _autoMarkPending = false;
  WORKER.nombre       = null;
  WORKER.tipo         = null;
  WORKER.doc          = null;
  WORKER.tScanInicio  = null;
  WORKER.tipoExcepcion = null;
  setWorkerState('IDLE');
  setConf(0, false);
  if (typeof clearSupervisorToken === 'function') clearSupervisorToken();
  const docVal = document.getElementById('docVal');
  if (docVal) { docVal.textContent = 'Digite su cédula'; docVal.className = 'doc-number ph'; }
  const docSub = document.getElementById('docSub');
  if (docSub) docSub.style.display = 'none';
  const docChk = document.getElementById('docChk');
  if (docChk) docChk.classList.remove('show');
}

/* ── Lógica de tipo (Entrada/Salida) ── */

function _getMarcasHoyCache() { try { return JSON.parse(localStorage.getItem('marcas_hoy_cache') || '{}'); } catch { return {}; } }

function _setMarcasHoyCache(doc, marcas) {
  const hoy = fechaLocalISO();
  const stored = _getMarcasHoyCache();
  if (stored._fecha !== hoy) { localStorage.setItem('marcas_hoy_cache', JSON.stringify({ _fecha: hoy })); }
  const fresh = _getMarcasHoyCache();
  fresh[doc] = marcas;
  localStorage.setItem('marcas_hoy_cache', JSON.stringify(fresh));
}

function _agregarMarcaLocal(doc, tipo) {
  const cache = _getMarcasHoyCache();
  const hoy = fechaLocalISO();
  if (cache._fecha !== hoy) { localStorage.setItem('marcas_hoy_cache', JSON.stringify({ _fecha: hoy })); }
  const fresh = _getMarcasHoyCache();
  if (!fresh[doc]) fresh[doc] = [];
  if (!fresh[doc].includes(tipo)) fresh[doc].push(tipo);
  localStorage.setItem('marcas_hoy_cache', JSON.stringify(fresh));
}

// Cola offline: buscar marcaciones pendientes por fechaLocal (no por fechaHora UTC)
function _marcasPendientesEnCola(doc) {
  const hoy  = fechaLocalISO();
  const cola = JSON.parse(localStorage.getItem('cola') || '[]');
  return cola
    .filter(m => {
      if (String(m.documento) !== String(doc)) return false;
      // Preferir fechaLocal; retrocompat con items viejos sin ese campo
      if (m.fechaLocal) return m.fechaLocal === hoy;
      return m.fechaHora && m.fechaHora.startsWith(hoy);
    })
    .map(m => m.tipo);
}

async function getTipo(doc) {
  const hoy = fechaLocalISO();

  const cacheHoy = _getMarcasHoyCache();
  let marcasConocidas = (cacheHoy._fecha === hoy && cacheHoy[doc]) ? [...cacheHoy[doc]] : [];

  const pendientes = _marcasPendientesEnCola(doc);
  pendientes.forEach(t => { if (!marcasConocidas.includes(t)) marcasConocidas.push(t); });

  if (marcasConocidas.includes('Salida')) return { tipo: 'Salida', completo: true,  marcas: marcasConocidas };
  if (marcasConocidas.includes('Entrada')) return { tipo: 'Salida', completo: false, marcas: marcasConocidas };

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
      if (m.includes('Salida')) return { tipo: 'Salida', completo: true,  marcas: m };
      if (m.includes('Entrada')) return { tipo: 'Salida', completo: false, marcas: m };
      return { tipo: 'Entrada', completo: false, marcas: m };
    } catch { /* backend no disponible */ }
  }

  return { tipo: null, completo: false, marcas: [], sinEstado: true };
}

/* ── Puntualidad (informativa — oficial viene del servidor) ── */
function _horaStrADecimal(s) {
  if (!s) return null;
  const p = String(s).split(':');
  if (p.length < 2) return null;
  return parseInt(p[0]) + parseInt(p[1]) / 60;
}

function calcularPuntualidad(tipo, hora) {
  const horario = getHorarioDelDia(hora.getDay());
  if (!horario || !horario.activo) return { estado: 'ok', msg: '', minutos: 0 };

  const h = hora.getHours() + hora.getMinutes() / 60;

  if (tipo === 'Entrada') {
    const entradaDec = _horaStrADecimal(horario.entrada);
    if (entradaDec === null) return { estado: 'ok', msg: '', minutos: 0 };
    const tolMin = (horario.tolEntrada != null ? horario.tolEntrada : 10) / 60;
    if (h <= entradaDec + tolMin) return { estado: 'ok', msg: 'A tiempo', minutos: 0 };
    const min = Math.round((h - entradaDec) * 60);
    return { estado: 'tarde', msg: `Tarde ${min} min`, minutos: min };
  }

  if (tipo === 'Salida') {
    const salidaDec = _horaStrADecimal(horario.salida);
    if (salidaDec === null) return { estado: 'ok', msg: '', minutos: 0 };
    const tolMin = (horario.tolSalida != null ? horario.tolSalida : 5) / 60;
    if (h >= salidaDec - tolMin) return { estado: 'ok', msg: 'A tiempo', minutos: 0 };
    const min = Math.round((salidaDec - h) * 60);
    return { estado: 'temprano', msg: `Salida ${min} min antes`, minutos: min };
  }

  return { estado: 'ok', msg: '', minutos: 0 };
}

/* ── ¿La marcación requiere supervisor que no puede encolarse offline? ── */
function _requiereSupervisorLocal(sinBiometria) {
  if (sinBiometria) return true;
  const geocercaLocal = CONFIG.FINCA.lat !== 0 && CONFIG.FINCA.lng !== 0;
  if (!geocercaLocal) return false;
  if (!gpsCoords) return true;
  if (!gpsOk) return true;
  const prec = gpsCoords.precision;
  if (prec == null || prec > 100) return true;
  return false;
}

const _MSG_REQUIERE_CONEXION = 'Esta marcación excepcional requiere conexión para ser autorizada por el supervisor.';

/* ── Marcación ──
   distanciaFacial: valor real de face-api (no reconstruido desde confPct).
   tipoExcepcion:   tipo de excepción cuando sinBiometria = true.
── */
async function ejecutarMarcacion(nombre, tipo, distanciaFacial, sinBiometria, tipoExcepcion) {
  // Refrescar GPS antes de construir el payload (timeout 5 s)
  if (typeof verificarGPSAhora === 'function') {
    await Promise.race([
      verificarGPSAhora(),
      new Promise(r => setTimeout(r, 5000)),
    ]);
  }

  const hora = new Date();
  const doc  = WORKER.doc ? String(WORKER.doc).trim() : '';
  if (!doc) {
    setWorkerState('IDLE');
    showRes('err', 'Sin documento', 'No se puede registrar sin número de documento.', ['Reingrese la cédula e intente nuevamente']);
    return;
  }

  // confPct solo para mostrar — nunca se reconstruye al revés para el payload
  const confPct = (distanciaFacial != null) ? Math.max(0, Math.round((1 - distanciaFacial) * 100)) : null;

  // Puntualidad local (informativa); la oficial vendrá del servidor
  const puntLocal = calcularPuntualidad(tipo, hora);

  // ID único de esta marcación — se conserva en todos los reintentos
  const marcacionId = _generarMarcacionId();

  // Distancia GPS a la geocerca calculada con la lectura fresca
  const gpsDistActual = (gpsCoords && CONFIG.FINCA.lat && CONFIG.FINCA.lng)
    ? Math.round(_distanciaGPS(gpsCoords.lat, gpsCoords.lng, CONFIG.FINCA.lat, CONFIG.FINCA.lng))
    : null;

  const excepcionFinal = sinBiometria ? (tipoExcepcion || 'SIN_BIOMETRIA') : null;

  const payload = {
    accion:              'marcar',
    marcacionId,
    documento:           doc,
    tipo,
    fechaHora:           hora.toISOString(),
    fechaLocal:          fechaLocalISO(),
    lat:                 gpsCoords ? gpsCoords.lat      : null,
    lng:                 gpsCoords ? gpsCoords.lng      : null,
    precisionGPS:        gpsCoords ? gpsCoords.precision : null,
    gpsEstadoActual:     typeof gpsEstado !== 'undefined' ? gpsEstado : null,
    gpsDistanciaMetros:  gpsDistActual,
    gpsFechaHora:        hora.toISOString(),
    distanciaFacial:     sinBiometria ? null : distanciaFacial,
    sinBiometria:        !!sinBiometria,
    tipoExcepcion:       excepcionFinal,
    motivoSupervisor:    excepcionFinal ? _motivoDesdeExcepcion(excepcionFinal) : null,
    fechaHoraAutorizacion: sinBiometria ? hora.toISOString() : null,
    dispositivo:         (typeof getDeviceId === 'function') ? getDeviceId() : null,
    supervisorToken:     (typeof getSupervisorToken === 'function') ? getSupervisorToken() : null,
    sinConexion:         false,
  };

  const horaStr = hora.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

  /* ── MODO OFFLINE ── */
  if (!navigator.onLine || !CONFIG.GS_URL) {
    if (_requiereSupervisorLocal(sinBiometria)) {
      setWorkerState('IDLE');
      showRes('warn', 'Conexión requerida', _MSG_REQUIERE_CONEXION,
        ['Active la conexión a internet e intente nuevamente']);
      return;
    }
    payload.sinConexion = true;
    _encolarOfflineConMeta(payload);
    updColaBadge();
    _agregarMarcaLocal(doc, tipo);
    _lastMarked[nombre] = Date.now();  // bloquear solo tras almacenamiento confirmado
    saveUltima(nombre, tipo, horaStr, gpsOk, Date.now());
    setWorkerState('CONFIRMED');
    showConf({ nombre, tipo, hora: horaStr, gpsOk, sinBiometria, punt: puntLocal, offline: true });
    return;
  }

  /* ── MODO ONLINE ── */
  let r;
  try {
    r = await enviarConResp(payload);
  } catch {
    r = null;
  }

  /* Error de red → encolar si no requiere supervisor */
  if (!r || r.networkError) {
    if (_requiereSupervisorLocal(sinBiometria)) {
      setWorkerState('IDLE');
      showRes('warn', 'Conexión requerida', _MSG_REQUIERE_CONEXION,
        ['Verifique la conexión a internet e intente nuevamente']);
      return;
    }
    payload.sinConexion = true;
    _encolarOfflineConMeta(payload);
    updColaBadge();
    _agregarMarcaLocal(doc, tipo);
    _lastMarked[nombre] = Date.now();
    saveUltima(nombre, tipo, horaStr, gpsOk, Date.now());
    setWorkerState('CONFIRMED');
    showConf({ nombre, tipo, hora: horaStr, gpsOk, sinBiometria, punt: puntLocal, offline: true });
    return;
  }

  /* Idempotencia: servidor ya procesó este marcacionId */
  if (r.idempotente) {
    const horaServidor = r.horaServidor || horaStr;
    _agregarMarcaLocal(doc, tipo);
    _lastMarked[nombre] = Date.now();
    saveUltima(r.nombre || nombre, tipo, horaServidor, r.dentroGeocerca, Date.now());
    const puntFinal = r.estadoPuntualidad
      ? { estado: r.estadoPuntualidad, msg: r.mensajePuntualidad || '', minutos: r.minutosDiferencia || 0 }
      : puntLocal;
    setWorkerState('CONFIRMED');
    showConf({ nombre: r.nombre || nombre, tipo, hora: horaServidor, gpsOk: r.dentroGeocerca, sinBiometria, punt: puntFinal, offline: false });
    return;
  }

  /* Fuera de geocerca o GPS ausente → modal supervisor */
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
      const excepGeo = r.gpsAusente ? 'GPS_AUSENTE' : 'FUERA_GEOCERCA';
      WORKER.tipoExcepcion = excepGeo;
      const msg = r.gpsAusente
        ? `GPS no disponible para <b>${xh(nombre)}</b>. Autorizar con PIN de supervisor.`
        : `<b>${xh(nombre)}</b> está fuera del predio${r.distanciaMetros != null ? ' (' + r.distanciaMetros + ' m)' : ''}. Autorizar con PIN de supervisor.`;
      abrirModalSupervisor(msg, () => ejecutarMarcacion(nombre, tipo, distanciaFacial, sinBiometria, excepGeo));
    }
    return;
  }

  /* Servidor rechazó — NO bloquear al trabajador */
  if (!r.ok) {
    setWorkerState('IDLE');
    showRes('err', 'Marcación no registrada', r.error || 'El servidor rechazó la marcación.', []);
    return;
  }

  /* ── ÉXITO CONFIRMADO POR SERVIDOR ── */
  _agregarMarcaLocal(doc, tipo);
  _lastMarked[nombre] = Date.now();  // bloquear solo tras confirmación del servidor

  const horaServidor = r.horaServidor || horaStr;
  saveUltima(r.nombre || nombre, tipo, horaServidor, r.dentroGeocerca, Date.now());

  // Puntualidad oficial del servidor; fallback al cálculo local
  const puntFinal = r.estadoPuntualidad
    ? { estado: r.estadoPuntualidad, msg: r.mensajePuntualidad || '', minutos: r.minutosDiferencia || 0 }
    : puntLocal;

  setWorkerState('CONFIRMED');
  showConf({
    nombre: r.nombre || nombre, tipo,
    hora: horaServidor, gpsOk: r.dentroGeocerca, sinBiometria, punt: puntFinal, offline: false,
  });
}

/* Encola con metadatos de reintento. Guarda fechaLocal. No duplica el mismo marcacionId. */
function _encolarOfflineConMeta(payload) {
  const c = JSON.parse(localStorage.getItem('cola') || '[]');
  // Idempotencia local: no duplicar si ya hay un item con el mismo marcacionId
  if (payload.marcacionId && c.some(x => x.marcacionId === payload.marcacionId)) return;
  c.push({ ...payload, _meta: { intentos: 0, ultimoIntento: null, ultimoError: null, estado: 'pendiente' } });
  localStorage.setItem('cola', JSON.stringify(c));
}

/* ── Callback de reconocimiento facial ──
   Recibe la distancia real de face-api — no reconstruida desde confPct.
── */
let _lastFaceMatch = null;
setFaceMatchCallback(async function onFaceMatch(nombre, dist) {
  if (_autoMarkPending) return;
  if (WORKER.state !== 'SCANNING') return;

  // Ventana anti-duplicado (5 min) — solo si la marcación anterior fue confirmada
  const now = Date.now();
  if (_lastMarked[nombre] && now - _lastMarked[nombre] < DUPLICATE_WINDOW_MS) return;

  // Filtrar si hay doc ingresado y no coincide con el reconocido
  if (WORKER.nombre && WORKER.nombre !== nombre) return;

  _autoMarkPending = true;
  _lastFaceMatch   = { nombre, dist };
  setWorkerState('VALIDATING');

  const tMatch = Date.now();

  if (WORKER.state !== 'VALIDATING') { _autoMarkPending = false; return; }

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
      WORKER.tipo    = tipo;
      WORKER.doc     = p.documento;
      WORKER.nombre  = nombre;
    }
  }

  if (!tipo) { _autoMarkPending = false; setWorkerState('IDLE'); return; }

  const rostros = getRostros();
  if (!rostros[nombre]) {
    _autoMarkPending = false;
    WORKER.tipoExcepcion = 'SIN_BIOMETRIA';
    setWorkerState('IDLE');
    abrirModalSupervisor(
      `<b>${xh(nombre)}</b> no tiene rostro enrolado. Un supervisor puede autorizar la marcación con su PIN.`,
      () => ejecutarMarcacion(nombre, tipo, null, true, 'SIN_BIOMETRIA')
    );
    return;
  }

  if (typeof registrarMetrica === 'function') {
    const tAhora = Date.now();
    registrarMetrica({
      evento: 'reconocimiento',
      nombre: nombre.slice(0, 3) + '***',
      dist: dist.toFixed(3),
      confPct: Math.max(0, Math.round((1 - dist) * 100)),
      msScanTotal: WORKER.tScanInicio ? tAhora - WORKER.tScanInicio : null,
      msHastaConfirmacion: tAhora - tMatch,
    });
  }

  // Pasar distanciaFacial directamente — no reconstruida desde confPct
  await ejecutarMarcacion(nombre, tipo, dist, false, null);
});

/* ── Entrada por documento ── */
let _procesarDocGen = 0;

async function procesarDoc(docVal, requestId) {
  const gen = (requestId != null) ? requestId : ++_procesarDocGen;
  const getActiveId = () => (typeof _docRequestId !== 'undefined') ? _docRequestId : gen;

  const docNum  = String(docVal).replace(/\D/g, '');
  const docSubEl = document.getElementById('docSub');
  const docChkEl = document.getElementById('docChk');

  if (!docNum) {
    if (docSubEl) docSubEl.style.display = 'none';
    if (docChkEl) docChkEl.classList.remove('show');
    setWorkerState('IDLE');
    return;
  }

  const persona = getPorDoc(docNum);
  if (!persona) {
    const inputActual = (document.getElementById('documentoInput')?.value || '').replace(/\D/g, '');
    if (docNum === inputActual) {
      if (docSubEl) { docSubEl.textContent = 'Documento no encontrado'; docSubEl.className = 'doc-info er'; docSubEl.style.display = 'block'; }
      if (docChkEl) docChkEl.classList.remove('show');
    }
    return;
  }

  if (docSubEl) { docSubEl.textContent = 'Verificando…'; docSubEl.className = 'doc-info'; docSubEl.style.display = 'block'; }
  if (docChkEl) docChkEl.classList.add('show');

  const res = await getTipo(docNum);

  const inputActualPost = (document.getElementById('documentoInput')?.value || '').replace(/\D/g, '');
  if (gen !== getActiveId() || docNum !== inputActualPost) return;

  if (res.completo) {
    if (docSubEl) { docSubEl.textContent = 'Ya completaste tu jornada hoy'; docSubEl.className = 'doc-info er'; }
    if (docChkEl) docChkEl.classList.remove('show');
    return;
  }

  if (res.sinEstado) {
    if (docSubEl) { docSubEl.textContent = 'Sin conexión — active el internet para verificar marcaciones'; docSubEl.className = 'doc-info er'; docSubEl.style.display = 'block'; }
    if (docChkEl) docChkEl.classList.remove('show');
    return;
  }

  if (docSubEl) { docSubEl.textContent = persona.nombre + ' · ' + persona.cargo; docSubEl.className = 'doc-info'; docSubEl.style.display = 'block'; }

  WORKER.nombre = persona.nombre;
  WORKER.tipo   = res.tipo;
  WORKER.doc    = docNum;
  setWorkerState('SCANNING', { nombre: persona.nombre, tipo: res.tipo, doc: docNum });
}
