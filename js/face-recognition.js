/* ── MÓDULO: Reconocimiento facial v2.1 ── */
const MODEL_URL = 'models';
let modOk = false, modErr = null, modCargando = false;
let stream = null;
let modoActual = null;        // null | 'enrolar' | 'procesando'
let nombreEnrolando = null;
let loopActivo = false;
let _faceMatchCallback = null;
let _inferenciaPendiente = false;
let _intervaloDyn = 280;
let _cameraSessionId = 0;    // incrementa en cada iniciarCamara() para invalidar getUserMedia tardío

// ── Instrucciones de enrolamiento (texto formal) ──
const PASOS_ENROL = [
  { txt: 'Mire directamente a la cámara.',    ico: '👁️' },
  { txt: 'Gire ligeramente a la izquierda.',  ico: '↖️' },
  { txt: 'Gire ligeramente a la derecha.',    ico: '↗️' },
  { txt: 'Levante ligeramente el rostro.',    ico: '⬆️' },
  { txt: 'Posición frontal — última captura.', ico: '✅' },
];
const CAPTURAS_ENROLAR   = 5;
const MIN_DELAY_CAPTURAS = 700;   // ms mínimo entre capturas consecutivas
const MAX_INTENTOS_PASO  = 15;    // intentos máximos por captura
const MAX_MS_PASO        = 12000; // tiempo máximo por captura (ms)

// Umbrales por versión de descriptor (techo absoluto: UMBRAL_MAX)
const UMBRAL_V2  = 0.49;   // v2 multi-pose — precisión alta
const UMBRAL_V1  = 0.54;   // v1 captura única — temporal, requiere reenrolamiento
const UMBRAL_MAX = 0.55;   // ningún umbral puede superar este valor

let errE = 0;
let _metricas = [];

function setFaceMatchCallback(fn) { _faceMatchCallback = fn; }

/* ══════════════════════════════════════════
   MODELOS
══════════════════════════════════════════ */
async function loadModels() {
  if (modCargando) return;
  modCargando = true; modOk = false; modErr = null;
  _setCamEstado('Cargando modelos IA…');
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    modOk = true;
    _setCamEstado('Mire directamente a la cámara.');
  } catch (e) {
    modErr = e.message || 'Error modelos';
    _setCamEstado('Error cargando modelos');
  }
  modCargando = false;
}

/* ══════════════════════════════════════════
   CÁMARA
══════════════════════════════════════════ */
async function iniciarCamara() {
  if (stream) return;
  const sessionId = ++_cameraSessionId;
  loopActivo = true;  // señal para que loopDeteccion() comience cuando el video esté listo
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'user' },
        width:  { ideal: 720 },
        height: { ideal: 720 },
      }
    });

    // Si la sesión fue cancelada mientras esperábamos getUserMedia, descartar inmediatamente
    if (sessionId !== _cameraSessionId) {
      s.getTracks().forEach(t => t.stop());
      return;
    }

    stream = s;
    const video = document.getElementById('video');
    if (video) {
      video.srcObject = stream;
      video.addEventListener('loadeddata', () => {
        if (sessionId !== _cameraSessionId) return;
        const ph = document.getElementById('camPlaceholder');
        if (ph) ph.style.display = 'none';
        _setCamEstado('Mire directamente a la cámara.');
        if (loopActivo && sessionId === _cameraSessionId) loopDeteccion();
      }, { once: true });
    }
  } catch {
    if (sessionId === _cameraSessionId) _setCamEstado('Sin acceso a cámara');
  }
}

function detenerCamara() {
  _cameraSessionId++;           // invalida getUserMedia o loadeddata en vuelo
  loopActivo = false;
  _inferenciaPendiente = false;
  _consecutivo = { nombre: null, t0: null, count: 0 };
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  const video = document.getElementById('video');
  if (video) video.srcObject = null;
  const ph = document.getElementById('camPlaceholder');
  if (ph) ph.style.display = 'flex';
}

/* ══════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════ */
function _setCamEstado(txt) {
  const el = document.getElementById('camEstado');
  if (el) el.textContent = txt;
}

function setConf(pct, ok) {
  const pe = document.getElementById('confPct');
  const fi = document.getElementById('confFill');
  if (!pe || !fi) return;
  if (pct === null || (pct === 0 && !ok)) {
    pe.textContent = '—'; pe.className = 'st-val na'; fi.style.width = '0%'; return;
  }
  pe.textContent = pct + '%'; pe.className = 'st-val ' + (ok ? 'ok' : 'er');
  fi.style.width = pct + '%';
  fi.style.background = ok ? 'var(--dg)' : pct > 50 ? 'var(--or)' : 'var(--re)';
}

function capFoto() {
  try {
    const video = document.getElementById('video');
    const c = document.createElement('canvas'); c.width = 240; c.height = 240;
    const ctx = c.getContext('2d'), vw = video.videoWidth, vh = video.videoHeight, l = Math.min(vw, vh);
    ctx.drawImage(video, (vw - l) / 2, (vh - l) / 2, l, l, 0, 0, 240, 240);
    return c.toDataURL('image/jpeg', 0.5);
  } catch { return ''; }
}

/* ══════════════════════════════════════════
   DESCRIPTORES — multi-descriptor v2
   v2: array de arrays (5 poses).
   v1 (legado): array plano de un solo descriptor.
══════════════════════════════════════════ */
function _esFormatoV2(raw) {
  return Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0]);
}

function _esV1(nombre) {
  const m = getRostrosMeta();
  return !m[nombre] || m[nombre].v !== 2;
}

function _getDescriptoresNombre(nombre) {
  const r = getRostros();
  const raw = r[nombre];
  if (!raw) return [];
  if (_esFormatoV2(raw)) return raw.map(d => new Float32Array(d));
  return [new Float32Array(raw)];  // v1: envuelto en array para compatibilidad
}

// Umbral efectivo según versión del descriptor — nunca supera UMBRAL_MAX
function _umbralParaNombre(nombre) {
  return Math.min(_esV1(nombre) ? UMBRAL_V1 : UMBRAL_V2, UMBRAL_MAX);
}

// Promedio de las 2 mejores distancias (más robusto que solo la mínima)
function _distanciaMedia2Mejores(descriptor, nombre) {
  const lista = _getDescriptoresNombre(nombre);
  if (!lista.length) return Infinity;
  const dists = lista.map(ref => faceapi.euclideanDistance(descriptor, ref)).sort((a, b) => a - b);
  if (dists.length === 1) return dists[0];
  return (dists[0] + dists[1]) / 2;
}

function saveRostroV2(nombre, descriptores) {
  const r = getRostros();
  r[nombre] = descriptores.map(d => Array.from(d));
  localStorage.setItem('rostros_enrolados', JSON.stringify(r));
  const m = getRostrosMeta();
  m[nombre] = { v: 2, fecha: new Date().toISOString(), capturas: descriptores.length };
  localStorage.setItem('rostros_meta', JSON.stringify(m));
}

/* ══════════════════════════════════════════
   CALIDAD DE CAPTURA (solo enrolamiento)
══════════════════════════════════════════ */
function _evaluarCalidad(det, video) {
  const w = video.videoWidth || 480, h = video.videoHeight || 480;
  const box = det.detection.box;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const issues = [];

  if (box.width < w * 0.10) issues.push('Acérquese un poco.');
  const margenX = w * 0.20, margenY = h * 0.20;
  if (cx < margenX || cx > w - margenX || cy < margenY || cy > h - margenY) {
    issues.push('Centre el rostro.');
  }
  if (det.detection.score < 0.52) issues.push('Mejore la iluminación.');

  return issues;
}

/* ══════════════════════════════════════════
   ENROLAMIENTO
══════════════════════════════════════════ */
function setProgreso(n, total) {
  const fi = document.getElementById('confFill'), pe = document.getElementById('confPct');
  if (fi) { fi.style.width = Math.round((n / total) * 100) + '%'; fi.style.background = 'var(--bl)'; }
  if (pe) { pe.textContent = `${n}/${total}`; pe.className = 'st-val'; }
}

function mostrarBannerEnrolar(nombre) {
  const b = document.getElementById('bannerEnrolar');
  if (b) b.style.display = 'flex';
  const nb = document.getElementById('bannerEnrolarNombre');
  if (nb) nb.textContent = nombre;
}

function ocultarBannerEnrolar() {
  const b = document.getElementById('bannerEnrolar');
  if (b) b.style.display = 'none';
}

function cancelarEnrolar() {
  modoActual = null;
  nombreEnrolando = null;
  ocultarBannerEnrolar();
  setProgreso(0, CAPTURAS_ENROLAR);
  detenerCamara();
  mostrarPantalla('pantallaMenu');
}

function pintarGrilla(id, cb) {
  const c = document.getElementById(id); if (!c) return;
  c.innerHTML = ''; const r = getRostros(); const m = getRostrosMeta();
  getPC().forEach(({ nombre }) => {
    const d = document.createElement('div'); d.className = 'persona';
    const i = document.createElement('div'); i.className = 'inicial'; i.textContent = inic(nombre);
    const n = document.createElement('div'); n.className = 'nom'; n.textContent = nombre;
    d.append(i, n);
    if (id === 'grillaEnrolar') {
      const e = document.createElement('div');
      e.style.cssText = 'font-size:10px;margin-top:4px;font-weight:700;';
      const meta = m[nombre];
      const enrolado = !!r[nombre];
      const capturas = meta ? meta.capturas || 1 : 0;
      const v2 = meta && meta.v === 2;
      if (enrolado) {
        e.textContent = v2 ? `✓ ${capturas} capturas` : '⚠ Requiere reenrolamiento';
        e.style.color  = v2 ? 'var(--dg)' : 'var(--or)';
      } else {
        e.textContent = 'Sin enrolar';
        e.style.color  = 'var(--re)';
      }
      d.append(e);
    }
    d.onclick = () => cb(nombre, d, c);
    c.appendChild(d);
  });
}

/* Intenta capturar un único paso del enrolamiento.
   Retorna { descriptor, foto } en éxito o { descriptor: null, motivo } si falla. */
async function _capturarPasoEnrol(paso) {
  const instruccion = PASOS_ENROL[paso];
  _setCamEstado(`${instruccion.ico} ${instruccion.txt}`);

  const tInicio = Date.now();
  let intentos  = 0;

  while (modoActual === 'enrolar') {
    if (intentos > 0) await new Promise(r => setTimeout(r, 350));
    intentos++;

    if (intentos > MAX_INTENTOS_PASO || Date.now() - tInicio > MAX_MS_PASO) {
      return { descriptor: null, foto: null, motivo: 'tiempo_agotado' };
    }

    let det;
    try {
      const video = document.getElementById('video');
      det = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      errE = 0;
    } catch (e) {
      errE++;
      if (errE >= 8) return { descriptor: null, foto: null, motivo: 'error_modelo' };
      continue;
    }

    if (!det) { _setCamEstado(`${instruccion.ico} No se detectó rostro — acérquese.`); continue; }

    const video2 = document.getElementById('video');
    const issues = _evaluarCalidad(det, video2);
    if (issues.length > 0) { _setCamEstado(`${instruccion.ico} ${issues[0]}`); continue; }

    // Captura válida — foto solo en la última pose frontal
    const foto = (paso === CAPTURAS_ENROLAR - 1) ? capFoto() : null;
    return { descriptor: det.descriptor, foto };
  }

  return { descriptor: null, foto: null, motivo: 'cancelado' };
}

async function procesarEnrolar() {
  if (modoActual !== 'enrolar') return;
  if (!modOk) {
    if (modErr) { modErr = null; loadModels(); }
    setTimeout(procesarEnrolar, 800);
    return;
  }
  document.getElementById('bloqueCamera').style.display = '';
  mostrarBannerEnrolar(nombreEnrolando);

  // La cámara no se inicia automáticamente en modo enrolamiento (el worker no pasa por SCANNING),
  // así que hay que arrancarla aquí explícitamente.
  if (!stream) {
    _setCamEstado('Iniciando cámara…');
    iniciarCamara();
    // Esperar a que el video esté listo (readyState ≥ 2) con timeout de 10 s
    const video = document.getElementById('video');
    const tCam  = Date.now();
    while (Date.now() - tCam < 10000) {
      if (modoActual !== 'enrolar') { ocultarBannerEnrolar(); detenerCamara(); return; }
      if (stream && video && video.readyState >= 2) break;
      await new Promise(r => setTimeout(r, 150));
    }
    if (!stream || !video || video.readyState < 2) {
      _setCamEstado('No se pudo acceder a la cámara.');
      modoActual = null; nombreEnrolando = null;
      ocultarBannerEnrolar();
      detenerCamara();
      showRes('err', 'Cámara no disponible',
        'No se pudo iniciar la cámara. Verifique que el navegador tenga permiso de cámara y que ninguna otra aplicación la esté usando.',
        ['Revise los permisos del navegador', 'Cierre otras apps que usen la cámara', 'Recargue la página e intente de nuevo']);
      setTimeout(() => mostrarPantalla('pantallaMenu'), 5000);
      return;
    }
  }

  const descriptores = [];
  let fotoCapturada  = null;
  setProgreso(0, CAPTURAS_ENROLAR);
  errE = 0;

  let paso = 0;
  while (paso < CAPTURAS_ENROLAR) {
    if (modoActual !== 'enrolar') { ocultarBannerEnrolar(); detenerCamara(); return; }

    if (paso > 0) {
      await new Promise(r => setTimeout(r, MIN_DELAY_CAPTURAS));
      if (modoActual !== 'enrolar') { ocultarBannerEnrolar(); detenerCamara(); return; }
    }

    const resultado = await _capturarPasoEnrol(paso);

    if (!resultado.descriptor) {
      if (resultado.motivo === 'cancelado') { ocultarBannerEnrolar(); detenerCamara(); return; }

      // Informar motivo y dar 3s para que el usuario decida (cancelar o esperar reintento)
      const motivo = resultado.motivo === 'error_modelo'
        ? 'Error analizando el rostro.'
        : 'No se pudo capturar este ángulo.';
      _setCamEstado(`⚠ ${motivo} Reintentando…`);
      await new Promise(r => setTimeout(r, 3000));
      if (modoActual !== 'enrolar') { ocultarBannerEnrolar(); detenerCamara(); return; }
      // Reintentar el mismo paso
      continue;
    }

    descriptores.push(resultado.descriptor);
    if (resultado.foto) fotoCapturada = resultado.foto;
    setProgreso(descriptores.length, CAPTURAS_ENROLAR);
    paso++;
  }

  if (modoActual !== 'enrolar') { ocultarBannerEnrolar(); detenerCamara(); return; }

  _setCamEstado('Guardando biometría…');
  saveRostroV2(nombreEnrolando, descriptores);

  const nombreGuardado = nombreEnrolando;
  modoActual      = null;
  nombreEnrolando = null;
  ocultarBannerEnrolar();
  detenerCamara();

  const pe   = getPC().find(p => p.nombre === nombreGuardado);
  const foto = fotoCapturada || '';

  if (!pe || !foto) {
    _guardarFotoPendiente(nombreGuardado, foto);
    showRes('ok', 'Biometría lista · foto pendiente',
      `<b>${xh(nombreGuardado)}</b> puede marcar asistencia. La foto se enviará al recuperar conexión.`, []);
    setTimeout(() => mostrarPantalla('pantallaMenu'), 4000);
    return;
  }

  const r = await enviarConResp({
    accion: 'guardarFotoPersonal',
    token: getAdminToken(),
    documento: pe.documento,
    foto,
    nombre: pe.nombre,
    cargo: pe.cargo,
  });

  if (!r || !r.ok) {
    _guardarFotoPendiente(nombreGuardado, foto);
    showRes('ok', 'Biometría lista · foto pendiente',
      `<b>${xh(nombreGuardado)}</b> puede marcar asistencia. La foto se enviará automáticamente.`, []);
  } else {
    showRes('ok', 'Empleado enrolado',
      `<b>${xh(nombreGuardado)}</b> ya puede marcar asistencia.`, []);
  }

  setTimeout(() => mostrarPantalla('pantallaMenu'), 3000);
}

/* ── Foto pendiente: persiste localmente y reintenta en reconexión ── */
function _guardarFotoPendiente(nombre, foto) {
  try {
    const p = JSON.parse(localStorage.getItem('fotos_pendientes') || '{}');
    p[nombre] = { foto, ts: new Date().toISOString() };
    localStorage.setItem('fotos_pendientes', JSON.stringify(p));
  } catch { /* storage lleno — ignorar */ }
}

async function _enviarFotosPendientes() {
  if (!navigator.onLine) return;
  let p;
  try { p = JSON.parse(localStorage.getItem('fotos_pendientes') || '{}'); } catch { return; }
  const nombres = Object.keys(p);
  if (!nombres.length) return;
  for (const nombre of nombres) {
    const { foto } = p[nombre];
    const pe = getPC().find(x => x.nombre === nombre);
    if (!pe || !foto) { delete p[nombre]; continue; }
    try {
      const r = await enviarConResp({
        accion: 'guardarFotoPersonal',
        token: getAdminToken(),
        documento: pe.documento,
        foto,
        nombre: pe.nombre,
        cargo: pe.cargo,
      });
      if (r && r.ok) delete p[nombre];
    } catch { /* reintentar próxima vez */ }
  }
  localStorage.setItem('fotos_pendientes', JSON.stringify(p));
}
window.addEventListener('online', _enviarFotosPendientes);

/* ══════════════════════════════════════════
   LOOP DE DETECCIÓN CONTINUA
   — Solo activo durante WORKER.state === 'SCANNING'
   — Si WORKER.nombre existe, compara solo contra ese trabajador
   — Umbrales por versión de descriptor
══════════════════════════════════════════ */
let _consecutivo = { nombre: null, t0: null, count: 0 };
const VENTANA_CONSEC_MS = 1800;
const HITS_REQUERIDOS   = 2;

async function loopDeteccion() {
  loopActivo = true;
  const video = document.getElementById('video');

  while (loopActivo) {
    await new Promise(r => setTimeout(r, _intervaloDyn));
    if (!loopActivo) break;

    // Pausar si no estamos en SCANNING (VALIDATING, CONFIRMED, IDLE)
    const workerState = (typeof WORKER !== 'undefined') ? WORKER.state : null;
    if (workerState && workerState !== 'SCANNING') {
      _inferenciaPendiente = false;
      _consecutivo = { nombre: null, t0: null, count: 0 };
      continue;
    }

    if (!modOk || !stream) continue;
    if (modoActual === 'procesando' || modoActual === 'enrolar') continue;
    if (_inferenciaPendiente) continue;
    if (!video || video.readyState < 2) { _setCamEstado('Iniciando cámara…'); continue; }

    _inferenciaPendiente = true;
    const t0 = Date.now();
    try {
      const det = await faceapi.detectSingleFace(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.45 })
      ).withFaceLandmarks().withFaceDescriptor();

      const duracion = Date.now() - t0;
      _intervaloDyn = Math.max(180, Math.min(600, Math.round(duracion * 0.65)));

      const camWrap = document.getElementById('camWrap');

      if (!det) {
        _setCamEstado('Mire directamente a la cámara.');
        if (camWrap) camWrap.classList.remove('scanning', 'face-ok');
        setConf(0, false);
        _consecutivo = { nombre: null, t0: null, count: 0 };
        _inferenciaPendiente = false;
        continue;
      }

      if (camWrap) camWrap.classList.add('scanning');

      const rostros     = getRostros();
      const workerNombre = (typeof WORKER !== 'undefined') ? WORKER.nombre : null;
      let mejorNombre   = null, mejorDist = Infinity;

      if (workerNombre && rostros[workerNombre]) {
        // Documento ingresado: comparar solo contra ese trabajador
        mejorDist   = _distanciaMedia2Mejores(det.descriptor, workerNombre);
        mejorNombre = workerNombre;
      } else {
        // Sin documento: búsqueda global
        const nombres = Object.keys(rostros);
        if (!nombres.length) {
          _setCamEstado('Sin empleados enrolados');
          setConf(null, false);
          _inferenciaPendiente = false;
          continue;
        }
        for (const n of nombres) {
          const dist = _distanciaMedia2Mejores(det.descriptor, n);
          if (dist < mejorDist) { mejorDist = dist; mejorNombre = n; }
        }
      }

      const pct    = Math.max(0, Math.round((1 - mejorDist) * 100));
      const umbral = mejorNombre ? _umbralParaNombre(mejorNombre) : UMBRAL_V2;

      registrarMetrica({ evento: 'dist', nombre: mejorNombre, dist: mejorDist.toFixed(4), umbral });

      if (mejorDist <= umbral) {
        if (camWrap) camWrap.classList.add('face-ok');
        setConf(pct, true);

        const v1 = mejorNombre && _esV1(mejorNombre);
        _setCamEstado(v1 ? 'Reconocido · Requiere reenrolamiento' : 'Rostro reconocido…');

        const ahora = Date.now();
        if (_consecutivo.nombre === mejorNombre && ahora - _consecutivo.t0 <= VENTANA_CONSEC_MS) {
          _consecutivo.count++;
        } else {
          _consecutivo = { nombre: mejorNombre, t0: ahora, count: 1 };
        }

        if (_consecutivo.count >= HITS_REQUERIDOS) {
          _consecutivo = { nombre: null, t0: null, count: 0 };
          if (_faceMatchCallback) _faceMatchCallback(mejorNombre, mejorDist);
        }
      } else {
        if (camWrap) camWrap.classList.remove('face-ok');
        setConf(pct, false);
        _consecutivo = { nombre: null, t0: null, count: 0 };
        const issues = _evaluarCalidad(det, video);
        if (issues.length > 0) {
          _setCamEstado(issues[0]);
        } else {
          _setCamEstado('Analizando…');
        }
      }
    } catch { /* ignorar errores de frame */ }

    _inferenciaPendiente = false;
  }
}

/* ══════════════════════════════════════════
   MÉTRICAS — localStorage, últimas 50
══════════════════════════════════════════ */
function registrarMetrica(evento) {
  try {
    const entrada = { ts: new Date().toISOString(), ua: navigator.userAgent.slice(0, 120), ...evento };
    _metricas.push(entrada);
    if (_metricas.length > 50) _metricas.shift();
    localStorage.setItem('fr_metricas', JSON.stringify(_metricas));
  } catch { /* no bloquear */ }
}
window._getFaceMetricas = () => _metricas;

/* ══════════════════════════════════════════
   ARRANQUE
══════════════════════════════════════════ */
loadModels();
setTimeout(() => {
  if (!modOk && !modErr && !modCargando) modErr = 'Tiempo agotado';
  if (modErr) _setCamEstado('Error: ' + modErr);
}, 15000);
