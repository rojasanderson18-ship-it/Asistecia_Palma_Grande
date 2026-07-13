/* ── MÓDULO: Reconocimiento facial ── */
const MODEL_URL = 'models';
let modOk = false, modErr = null, modCargando = false;
let stream = null;
let modoActual = null;
let nombreEnrolando = null;
let loopActivo = false;
let _faceMatchCallback = null;

const CAPTURAS_ENROLAR = 3;
let errE = 0;

// Llamado por attendance.js para recibir notificación de match facial
function setFaceMatchCallback(fn) { _faceMatchCallback = fn; }

async function loadModels() {
  if (modCargando) return;
  modCargando = true; modOk = false; modErr = null;
  _setCamEstado('Cargando modelos IA…');
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);
    modOk = true;
    _setCamEstado('Mirá la cámara…');
  } catch(e) {
    modErr = e.message || 'Error modelos';
    _setCamEstado('Error cargando modelos');
  }
  modCargando = false;
}

function _setCamEstado(txt) {
  const el = document.getElementById('camEstado');
  if (el) el.textContent = txt;
}

async function iniciarCamara() {
  if (stream) return; // ya activa
  try {
    stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'user', width:480, height:480}});
    const video = document.getElementById('video');
    if (video) {
      video.srcObject = stream;
      video.addEventListener('loadeddata', () => {
        const ph = document.getElementById('camPlaceholder');
        if (ph) ph.style.display = 'none';
        _setCamEstado('Mirá la cámara…');
        if (!loopActivo) loopDeteccion();
      }, {once: true});
    }
  } catch(e) {
    _setCamEstado('Sin acceso a cámara');
  }
}

function detenerCamara() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  const video = document.getElementById('video');
  if (video) video.srcObject = null;
  const ph = document.getElementById('camPlaceholder');
  if (ph) ph.style.display = 'flex';
  loopActivo = false;
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
    ctx.drawImage(video, (vw-l)/2, (vh-l)/2, l, l, 0, 0, 240, 240);
    return c.toDataURL('image/jpeg', 0.5);
  } catch { return ''; }
}

function promediarDescriptores(lista) {
  const len = lista[0].length, avg = new Float32Array(len);
  for (const d of lista) for (let i = 0; i < len; i++) avg[i] += d[i];
  for (let i = 0; i < len; i++) avg[i] /= lista.length;
  return avg;
}

function setProgreso(n, total) {
  _setCamEstado(`Enrolando: ${n}/${total} — quédate quieto`);
  const fi = document.getElementById('confFill'), pe = document.getElementById('confPct');
  if (fi) { fi.style.width = Math.round((n/total)*100) + '%'; fi.style.background = 'var(--bl)'; }
  if (pe) { pe.textContent = `${n}/${total}`; pe.className = 'st-val'; }
}

function mostrarBannerEnrolar(nombre) {
  const b = document.getElementById('bannerEnrolar');
  if (b) { b.style.display = 'flex'; }
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
  c.innerHTML = ''; const r = getRostros();
  getPC().forEach(({nombre}) => {
    const d = document.createElement('div'); d.className = 'persona';
    const i = document.createElement('div'); i.className = 'inicial'; i.textContent = inic(nombre);
    const n = document.createElement('div'); n.className = 'nom'; n.textContent = nombre;
    d.append(i, n);
    if (id === 'grillaEnrolar') {
      const e = document.createElement('div');
      e.style.cssText = 'font-size:10px;margin-top:4px;font-weight:700;';
      e.textContent = r[nombre] ? '✓ Enrolado' : 'Sin enrolar';
      e.style.color = r[nombre] ? 'var(--dg)' : 'var(--re)';
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

  while (descriptores.length < CAPTURAS_ENROLAR) {
    if (modoActual !== 'enrolar') { ocultarBannerEnrolar(); return; }
    await new Promise(r => setTimeout(r, 300));
    let det;
    try {
      const video = document.getElementById('video');
      det = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({inputSize:224, scoreThreshold:0.5})).withFaceLandmarks().withFaceDescriptor();
      errE = 0;
    } catch(e) {
      errE++;
      if (errE >= 8) { modoActual = null; ocultarBannerEnrolar(); showRes('err', 'Error analizando rostro', xh(e.message || String(e)), []); return; }
      continue;
    }
    if (!det) { _setCamEstado('No detecto rostro — acércate a la cámara'); continue; }
    descriptores.push(det.descriptor);
    setProgreso(descriptores.length, CAPTURAS_ENROLAR);
  }

  if (modoActual !== 'enrolar') { ocultarBannerEnrolar(); return; }
  _setCamEstado('Guardando…');
  const descriptorFinal = promediarDescriptores(descriptores);
  saveRostro(nombreEnrolando, descriptorFinal);
  modoActual = null;
  ocultarBannerEnrolar();

  const pe = getPC().find(p => p.nombre === nombreEnrolando);
  const foto = capFoto();
  if (!pe || !foto) {
    showRes('err', 'Rostro guardado, foto no', `<b>${xh(nombreEnrolando)}</b> puede marcar pero no se guardó la foto.`, []);
    setTimeout(() => mostrarPantalla('pantallaMarcacion'), 4000); return;
  }
  const r = await enviarConResp({accion:'guardarFotoPersonal', documento:pe.documento, foto, nombre:pe.nombre, cargo:pe.cargo});
  if (!r || !r.ok || !r.fotoURL) {
    showRes('err', 'Rostro guardado, foto no', `<b>${xh(nombreEnrolando)}</b> puede marcar pero hubo un error en Drive.`, []);
    setTimeout(() => mostrarPantalla('pantallaMarcacion'), 4000); return;
  }
  showRes('ok', 'Empleado enrolado', `<b>${xh(nombreEnrolando)}</b> ya puede marcar asistencia`, []);
  setTimeout(() => mostrarPantalla('pantallaMarcacion'), 3000);
}

async function loopDeteccion() {
  loopActivo = true;
  const video = document.getElementById('video');
  while (true) {
    await new Promise(r => setTimeout(r, 250));
    if (!modOk || !stream) continue;
    if (modoActual === 'procesando' || modoActual === 'enrolar') continue;
    try {
      const det = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({inputSize:160, scoreThreshold:0.45})).withFaceLandmarks().withFaceDescriptor();
      const camWrap = document.getElementById('camWrap');
      if (!det) {
        _setCamEstado('Mirá la cámara…');
        if (camWrap) camWrap.classList.remove('scanning', 'face-ok');
        setConf(0, false);
        continue;
      }
      if (camWrap) camWrap.classList.add('scanning');
      _setCamEstado('Analizando…');

      const rostros = getRostros();
      const nombres = Object.keys(rostros);
      if (nombres.length > 0) {
        let mejorNombre = null, mejorDist = Infinity;
        for (const n of nombres) {
          const dist = faceapi.euclideanDistance(det.descriptor, new Float32Array(rostros[n]));
          if (dist < mejorDist) { mejorDist = dist; mejorNombre = n; }
        }
        const pct = Math.max(0, Math.round((1 - mejorDist) * 100));
        if (mejorDist <= CONFIG.UMBRAL_FACIAL) {
          if (camWrap) camWrap.classList.add('face-ok');
          setConf(pct, true);
          if (_faceMatchCallback) _faceMatchCallback(mejorNombre, mejorDist);
        } else {
          if (camWrap) camWrap.classList.remove('face-ok');
          setConf(pct, false);
        }
      } else {
        _setCamEstado('Sin empleados enrolados');
        setConf(null, false);
      }
    } catch { continue; }
  }
}

// Iniciar carga de modelos y cámara al cargar
loadModels();
setTimeout(() => {
  if (!modOk && !modErr && !modCargando) modErr = 'Tiempo agotado';
  if (modErr) _setCamEstado('Error: ' + modErr);
}, 45000);
