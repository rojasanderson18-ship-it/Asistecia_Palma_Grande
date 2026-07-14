/* ── MÓDULO: Cola offline ── */

const APP_VERSION_CLIENT = '4.0';
const MAX_REINTENTOS_COLA = 10;

// Palabras clave de errores permanentes (no tiene sentido reintentar)
const _ERRORES_PERMANENTES = [
  'Ya existe una Entrada',
  'Ya existe una Salida',
  'No hay Entrada registrada',
  'Jornada completa',
  'Empleado no registrado',
  'Tipo inválido',
  'documento requerido',
  'Documento inválido',
];
// Errores de dispositivo (detener toda sincronización)
const _ERRORES_DISPOSITIVO = [
  'Dispositivo no autorizado',
  'Dispositivo inactivo',
];

function _esErrorPermanente(errorMsg) {
  const msg = String(errorMsg || '');
  return _ERRORES_PERMANENTES.some(function(e) { return msg.indexOf(e) !== -1; });
}

function _esErrorDispositivo(errorMsg) {
  const msg = String(errorMsg || '');
  return _ERRORES_DISPOSITIVO.some(function(e) { return msg.indexOf(e) !== -1; });
}

// Enriquece el payload con deviceToken, deviceId y appVersion antes de enviarlo
function _enriquecerPayload(p) {
  const tok = (typeof getDeviceToken === 'function') ? getDeviceToken() : null;
  const did = (typeof getDeviceId === 'function') ? getDeviceId() : null;
  const base = Object.assign({}, p);
  if (tok && !base.deviceToken) base.deviceToken = tok;
  if (did && !base.deviceId) base.deviceId = did;
  if (!base.appVersion) base.appVersion = APP_VERSION_CLIENT;
  return base;
}


async function enviarConResp(p) {
  const payload = _enriquecerPayload(p);
  if (!CONFIG.GS_URL || CONFIG.GS_URL.includes('PEGAR')) return null;
  const ctrl = new AbortController();
  const timo = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(CONFIG.GS_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload), signal: ctrl.signal,
    });
    return r.json();
  } catch (e) {
    return { ok: false, networkError: true, error: e.message };
  } finally {
    clearTimeout(timo);
  }
}

let _reintentando = false;
async function reintentarCola() {
  if (_reintentando || !CONFIG.GS_URL) return;
  const c = JSON.parse(localStorage.getItem('cola') || '[]');
  if (!c.length) return;
  _reintentando = true;

  const pendientes  = [];
  const rechazados  = JSON.parse(localStorage.getItem('cola_rechazados') || '[]');
  let dispositivoRevocado = false;

  for (const item of c) {
    if (dispositivoRevocado) {
      // Detener todo si el dispositivo fue revocado
      pendientes.push(item);
      continue;
    }

    const meta = item._meta || { intentos: 0 };
    if (meta.intentos >= MAX_REINTENTOS_COLA) {
      // Demasiados intentos → mover a rechazados permanentemente
      rechazados.push({ ...item, _meta: { ...meta, estado: 'max_reintentos', ultimoIntento: new Date().toISOString() } });
      continue;
    }

    const payload = _enriquecerPayload(item);
    // Quitar _meta del payload antes de enviarlo
    delete payload._meta;

    let r = null;
    const iCtrl = new AbortController();
    const iTimo = setTimeout(() => iCtrl.abort(), 12000);
    try {
      const resp = await fetch(CONFIG.GS_URL, {
        method: 'POST', headers: {'Content-Type':'text/plain'},
        body: JSON.stringify(payload), signal: iCtrl.signal,
      });
      r = await resp.json();
    } catch {
      // Error de red transitorio — conservar para reintentar
      pendientes.push({
        ...item,
        _meta: { ...meta, intentos: meta.intentos + 1, ultimoIntento: new Date().toISOString(), ultimoError: 'Error de red', estado: 'pendiente' }
      });
      continue;
    } finally {
      clearTimeout(iTimo);
    }

    if (r && r.ok) {
      // Éxito — descartar de la cola
      continue;
    }

    const errorMsg = (r && r.error) || 'Error desconocido';

    if (_esErrorDispositivo(errorMsg)) {
      // Dispositivo revocado o no autorizado — detener sincronización
      dispositivoRevocado = true;
      rechazados.push({ ...item, _meta: { ...meta, estado: 'dispositivo_revocado', ultimoError: errorMsg, ultimoIntento: new Date().toISOString() } });
      _mostrarAlertaDispositivoRevocado(errorMsg);
      continue;
    }

    if (_esErrorPermanente(errorMsg)) {
      // Error permanente — mover a rechazados, no reintentar
      rechazados.push({ ...item, _meta: { ...meta, estado: 'rechazado', ultimoError: errorMsg, ultimoIntento: new Date().toISOString(), respuestaServidor: r } });
      continue;
    }

    // Error transitorio — conservar para reintentar
    pendientes.push({
      ...item,
      _meta: { ...meta, intentos: meta.intentos + 1, ultimoIntento: new Date().toISOString(), ultimoError: errorMsg, estado: 'pendiente' }
    });
  }

  localStorage.setItem('cola', JSON.stringify(pendientes));
  localStorage.setItem('cola_rechazados', JSON.stringify(rechazados.slice(-50))); // conservar últimos 50
  _reintentando = false;
  updColaBadge();
}

function _mostrarAlertaDispositivoRevocado(error) {
  // Guardar alerta para que el administrador la vea al abrir la app
  localStorage.setItem('alerta_dispositivo', JSON.stringify({
    mensaje: error, fecha: new Date().toISOString()
  }));
  // Mostrar toast si la UI está disponible
  if (typeof showToast === 'function') {
    showToast('⚠ Dispositivo no autorizado — sincronización detenida');
  }
}

function updColaBadge() {
  const c = JSON.parse(localStorage.getItem('cola') || '[]');
  const badge = document.getElementById('colaBadge');
  const cnt = document.getElementById('colaCnt');
  if (!badge) return;
  if (c.length > 0) { badge.style.display = 'block'; if (cnt) cnt.textContent = c.length; }
  else { badge.style.display = 'none'; }
}

window.addEventListener('online', reintentarCola);
setInterval(reintentarCola, 120000);
setTimeout(() => {
  reintentarCola();
  updColaBadge();
  // Mostrar alerta de dispositivo revocado si existe
  const alerta = JSON.parse(localStorage.getItem('alerta_dispositivo') || 'null');
  if (alerta && typeof showToast === 'function') {
    showToast('⚠ Este kiosco fue desautorizado — contacta al administrador');
  }
}, 3000);
