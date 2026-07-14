/* ── MÓDULO: Reconocimiento facial v2.0 ── */
const MODEL_URL = 'models';
let modOk = false, modErr = null, modCargando = false;
let stream = null;
let modoActual = null;       // null | 'enrolar' | 'procesando'
let nombreEnrolando = null;
let loopActivo = false;
let _faceMatchCallback = null;
let _inferenciaPendiente = false;  // evita inferencias simultáneas
let _intervaloDyn = 280;           // ms entre detecciones, ajustado dinámicamente

// ── Instrucciones de enrolamiento por paso ──
const PASOS_ENROL = [
  { txt: 'Mira directo a la cámara',          ico: '👁️' },
  { txt: 'Gira levemente a la izquierda',      ico: '↖️' },
  { txt: 'Gira levemente a la derecha',        ico: '↗️' },
  { txt: 'Levanta ligeramente el rostro',      ico: '⬆️' },
  { txt: 'Posición frontal — última captura',  ico: '✅' },
];
const CAPTURAS_ENROLAR = 5;
const MIN_DELAY_CAPTURAS = 700; // ms entre capturas de enrolamiento

let errE = 0;
let _metricas = [];  // métricas de sesión (requisito 12)

// ── Callback facial ──
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
    _setCamEstado('Mirá la cámara…');
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
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'user' },
        width:  { ideal: 720 },
        height: { ideal: 720 },
      }
    });
    const video = document.getElementById('video');
    if (video) {
      video.srcObject = stream;
      video.addEventListener('loadeddata', () => {
        const ph = document.getElementById('camPlaceholder');
        if (ph) ph.style.display = 'none';
        _setCamEstado('Mirá la cámara…');
        if (!loopActivo) loopDeteccion();
      }, { once: true });
    }
  } catch (e) {
    _setCamEstado('Sin acceso a cámara');
  }
}

function detenerCamara() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  const video = document.getElementById('video');
  if (video) video.srcObject = null;
  const ph = document.getElementById('camPlaceholder');
  if (ph) ph.style.display = 'flex';
  loopActivo = false;
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
   Guardamos hasta 5 descriptores por persona.
   Formato v2: array de arrays (Float32Array serializado).
   Formato v1 (legado): array plano de un solo descriptor.
══════════════════════════════════════════ */
function _esFormatoV2(raw) {
  return Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0]);
}

function _getDescriptoresNombre(nombre) {
  const r = getRostros();
  const raw = r[nombre];
  if (!raw) return [];
  if (_esFormatoV2(raw)) return raw.map(d => new Float32Array(d));
  // v1: descriptor plano → envuelto en array para compatibilidad
  return [new Float32Array(raw)];
}

// Distancia mínima contra todos los descriptores del trabajador
function _distanciaMinima(descriptor, nombre) {
  const lista = _getDescriptoresNombre(nombre);
  if (!lista.length) return Infinity;
  let min = Infinity;
  for (const ref of lista) {
    const d = faceapi.euclideanDistance(descriptor, ref);
    if (d < min) min = d;
  }
  return min;
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
  // Guardar como array de arrays (v2)
  const r = getRostros();
  r[nombre] = descriptores.map(d => Array.from(d));
  localStorage.setItem('rostros_enrolados', JSON.stringify(r));
  const m = getRostrosMeta();
  m[nombre] = { v: 2, fecha: new Date().toISOString(), capturas: descriptores.length };
  localStorage.setItem('rostros_meta', JSON.stringify(m));
}

/* ══════════════════════════════════════════
   CALIDAD DE CAPTURA
══════════════════════════════════════════ */
function _evaluarCalidad(det, video) {
  const w = video.videoWidth || 480, h = video.videoHeight || 480;
  const box = det.detection.box;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const issues = [];

  // Tamaño mínimo del rostro (10% del ancho del frame)
  if (box.width < w * 0.10) { issues.push('Acércate más a la cámara'); }

  // Rostro centrado (dentro del 60% central)
  const margenX = w * 0.20, margenY = h * 0.20;
  if (cx < margenX || cx > w - margenX || cy < margenY || cy > h - margenY) {
    issues.push('Centra el rostro');
  }

  // Score de detección (confianza)
  if (det.detection.score < 0.55) { issues.push('Mejora la iluminación'); }

  // Landmarks: verificar visibilidad de ojos (puntos 36-41 ojo izq, 42-47 ojo der)
  if (det.landmarks) {
    const pts = det.landmarks.positions;
    if (pts && pts.length >= 48) {
      const ojoDer = pts.slice(36, 42);
      const ojoIzq = pts.slice(42, 48);
      const spanDer = Math.abs(ojoDer[3].x - ojoDer[0].x);
      const spanIzq = Math.abs(ojoIzq[3].x - ojoIzq[0].x);
      if (spanDer < 5 || spanIzq < 5) issues.push('Mira de frente, ojos visibles');
    }
  }

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
  modoActual = null; nombreEnrolando = null;
  ocultarBannerEnrolar();
  mostrarPantalla('pantallaMarcacion');
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
      e.textContent = enrolado ? (v2 ? `✓ ${capturas} capturas` : '✓ Enrolado (v1)') : 'Sin enrolar';
      e.style.color = enrolado ? 'var(--dg)' : 'var(--re)';
      d.append(e);
    }
    d.onclick = () => cb(nombre, d, c);
    c.appendChild(d);
  });
}

async function procesarEnrolar() {
  if (modoActual !== 'enrolar') return;
  if (!modOk) {
    if (modErr) { modErr = null; loadModels(); }
    setTimeout(procesarEnrolar, 800); return;
  }
  document.getElementById('bloqueCamera').style.display = '';
  mostrarBannerEnrolar(nombreEnrolando);

  const descriptores = [];
  setProgreso(0, CAPTURAS_ENROLAR);
  errE = 0;

  for (let paso = 0; paso < CAPTURAS_ENROLAR; paso++) {
    if (modoActual !== 'enrolar') { ocultarBannerEnrolar(); return; }

    const instruccion = PASOS_ENROL[paso];
    _setCamEstado(`${instruccion.ico} ${instruccion.txt}`);

    // Esperar al menos MIN_DELAY_CAPTURAS ms desde la captura anterior
    await new Promise(r => setTimeout(r, paso === 0 ? 300 : MIN_DELAY_CAPTURAS));

    let capturada = false;
    let intentosPaso = 0;
    while (!capturada) {
      if (modoActual !== 'enrolar') { ocultarBannerEnrolar(); return; }
      if (intentosPaso > 0) await new Promise(r => setTimeout(r, 300));
      intentosPaso++;

      let det;
      try {
        const video = document.getElementById('video');
        det = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
          .withFaceLandmarks().withFaceDescriptor();
        errE = 0;
      } catch (e) {
        errE++;
        if (errE >= 8) {
          modoActual = null; ocultarBannerEnrolar();
          showRes('err', 'Error analizando rostro', xh(e.message || String(e)), []);
          return;
        }
        continue;
      }

      if (!det) { _setCamEstado(`${instruccion.ico} No se detectó rostro — acércate`); continue; }

      const video2 = document.getElementById('video');
      const issues = _evaluarCalidad(det, video2);
      if (issues.length > 0) {
        _setCamEstado(`${instruccion.ico} ${issues[0]}`);
        continue;
      }

      descriptores.push(det.descriptor);
      capturada = true;
      setProgreso(descriptores.length, CAPTURAS_ENROLAR);
    }
  }

  if (modoActual !== 'enrolar') { ocultarBannerEnrolar(); return; }
  _setCamEstado('Guardando…');
  saveRostroV2(nombreEnrolando, descriptores);
  modoActual = null;
  ocultarBannerEnrolar();

  const pe = getPC().find(p => p.nombre === nombreEnrolando);
  const foto = capFoto();
  if (!pe || !foto) {
    showRes('err', 'Rostro guardado, foto no', `<b>${xh(nombreEnrolando)}</b> puede marcar pero no se guardó la foto.`, []);
    setTimeout(() => mostrarPantalla('pantallaMarcacion'), 4000); return;
  }
  const r = await enviarConResp({ accion: 'guardarFotoPersonal', token: getAdminToken(), documento: pe.documento, foto, nombre: pe.nombre, cargo: pe.cargo });
  if (!r || !r.ok) {
    showRes('err', 'Rostro guardado, foto no', `<b>${xh(nombreEnrolando)}</b> puede marcar pero hubo un error en Drive.`, []);
    setTimeout(() => mostrarPantalla('pantallaMarcacion'), 4000); return;
  }
  showRes('ok', 'Empleado enrolado', `<b>${xh(nombreEnrolando)}</b> ya puede marcar asistencia`, []);
  setTimeout(() => mostrarPantalla('pantallaMarcacion'), 3000);
}

/* ══════════════════════════════════════════
   LOOP DE DETECCIÓN CONTINUA
   — inputSize 224
   — sin inferencias simultáneas
   — intervalo dinámico según rendimiento
   — instrucciones en tiempo real
   — ventana de 2 coincidencias consecutivas (800 ms)
══════════════════════════════════════════ */
let _consecutivo = { nombre: null, t0: null, count: 0 };
const VENTANA_CONSEC_MS = 800;
const HITS_REQUERIDOS   = 2;

async function loopDeteccion() {
  loopActivo = true;
  const video = document.getElementById('video');

  while (true) {
    await new Promise(r => setTimeout(r, _intervaloDyn));
    if (!modOk || !stream) continue;
    if (modoActual === 'procesando' || modoActual === 'enrolar') continue;
    if (_inferenciaPendiente) continue;

    // Esperar readyState suficiente
    if (!video || video.readyState < 2) { _setCamEstado('Iniciando cámara…'); continue; }

    _inferenciaPendiente = true;
    const t0 = Date.now();
    try {
      const det = await faceapi.detectSingleFace(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 })
      ).withFaceLandmarks().withFaceDescriptor();

      const duracion = Date.now() - t0;
      // Ajuste dinámico: mantener ~60% de carga
      _intervaloDyn = Math.max(180, Math.min(600, Math.round(duracion * 0.65)));

      const camWrap = document.getElementById('camWrap');

      if (!det) {
        _setCamEstado('Mirá la cámara…');
        if (camWrap) camWrap.classList.remove('scanning', 'face-ok');
        setConf(0, false);
        _consecutivo = { nombre: null, t0: null, count: 0 };
        _inferenciaPendiente = false;
        continue;
      }

      if (camWrap) camWrap.classList.add('scanning');

      const rostros = getRostros();
      const nombres = Object.keys(rostros);
      if (!nombres.length) {
        _setCamEstado('Sin empleados enrolados');
        setConf(null, false);
        _inferenciaPendiente = false;
        continue;
      }

      // Buscar mejor coincidencia (promedio 2 mejores descriptores)
      let mejorNombre = null, mejorDist = Infinity;
      for (const n of nombres) {
        const dist = _distanciaMedia2Mejores(det.descriptor, n);
        if (dist < mejorDist) { mejorDist = dist; mejorNombre = n; }
      }

      const pct = Math.max(0, Math.round((1 - mejorDist) * 100));
      const umbral = typeof CONFIG !== 'undefined' ? CONFIG.UMBRAL_FACIAL : 0.48;

      if (mejorDist <= umbral) {
        // Reconocimiento válido — las verificaciones de calidad son solo para enrolamiento
        if (camWrap) camWrap.classList.add('face-ok');
        setConf(pct, true);
        _setCamEstado('Rostro reconocido…');

        // Acumular coincidencias consecutivas
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
        // Usar calidad solo para orientar al usuario, nunca para bloquear
        const issues = _evaluarCalidad(det, video);
        _setCamEstado(issues.length > 0 ? issues[0] : 'Analizando…');
      }
    } catch { /* ignorar errores de frame */ }

    _inferenciaPendiente = false;
  }
}

/* ══════════════════════════════════════════
   MÉTRICAS (req. 12) — solo localStorage
══════════════════════════════════════════ */
function registrarMetrica(evento) {
  try {
    const ua = navigator.userAgent;
    const entrada = {
      ts: new Date().toISOString(),
      ua: ua.slice(0, 120),
      ...evento,
    };
    _metricas.push(entrada);
    // Mantener solo las últimas 50 métricas
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
