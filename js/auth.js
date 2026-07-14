/* ── MÓDULO: Autenticación administrativa ── */
/*
 * PIN nunca en código fuente, LocalStorage ni texto plano.
 * Flujo: SHA-256(pin) → POST login → backend valida contra PropertiesService.PIN_HASH
 *        → backend devuelve token de sesión temporal (15 min admin / 5 min supervisor).
 * Token almacenado solo en memoria (variable de módulo), no en LocalStorage.
 * Sin validación local. Sin almacenamiento de PIN, hash ni sal en el dispositivo.
 * Para configurar el PIN inicial: ejecutar setPin('XXXX') en Google Apps Script.
 */

let _adminToken = null;
let _supervisorToken = null;
let _adminSessionTimer = null;
const _ADMIN_SESSION_MS = 15 * 60 * 1000;
const _ADMIN_AVISO_MS  = 13 * 60 * 1000;

function _programarExpiracionAdmin() {
  if (_adminSessionTimer) clearTimeout(_adminSessionTimer);
  _adminSessionTimer = setTimeout(() => {
    if (typeof showToast === 'function') showToast('⚠ Sesión admin expira en 2 minutos — guarda los cambios');
    _adminSessionTimer = setTimeout(() => {
      _adminToken = null;
      _adminSessionTimer = null;
      if (typeof showToast === 'function') showToast('Sesión admin expirada — ingresa el PIN nuevamente');
      if (typeof mostrarPantalla === 'function') mostrarPantalla('pantallaMarcacion');
    }, _ADMIN_SESSION_MS - _ADMIN_AVISO_MS);
  }, _ADMIN_AVISO_MS);
}

function _getDeviceId() {
  let id = localStorage.getItem('device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('device_id', id);
  }
  return id;
}

async function _sha256(texto) {
  const encoder = new TextEncoder();
  const data = encoder.encode(texto);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _postGs(payload, timeoutMs) {
  const ctrl = new AbortController();
  const timo = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(CONFIG.GS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!r.ok) return { ok: false, error: 'Error del servidor (' + r.status + ')' };
    return r.json();
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: 'Sin respuesta del servidor (tiempo agotado)' };
    return { ok: false, error: e.message || 'Error de red' };
  } finally {
    clearTimeout(timo);
  }
}

/* ── Login admin: valida PIN y obtiene token de sesión (15 min) ── */
async function login(pin) {
  if (!pin) return { ok: false, error: 'Ingresa el PIN' };
  if (!CONFIG.GS_URL) return { ok: false, error: 'Configura la URL del servidor en Ajustes' };
  try {
    const hash = await _sha256(String(pin));
    const deviceId = _getDeviceId();
    const d = await _postGs({ accion: 'login', hash, deviceId });
    if (d.ok && d.token) {
      _adminToken = d.token;
      _programarExpiracionAdmin();
      return { ok: true, token: d.token, expiresIn: d.expiresIn };
    }
    return { ok: false, error: d.error || 'PIN incorrecto' };
  } catch {
    return { ok: false, error: 'Sin conexión al servidor' };
  }
}

/* ── Login supervisor: valida PIN supervisor y obtiene token (5 min) ── */
async function loginSupervisor(pin) {
  if (!pin) return { ok: false, error: 'Ingresa el PIN' };
  if (!CONFIG.GS_URL) return { ok: false, error: 'Configura la URL del servidor en Ajustes' };
  try {
    const hash = await _sha256(String(pin));
    const deviceId = _getDeviceId() + '_sup';
    const d = await _postGs({ accion: 'loginSupervisor', hash, deviceId });
    if (d.ok && d.token) {
      _supervisorToken = d.token;
      return { ok: true, token: d.token, expiresIn: d.expiresIn };
    }
    return { ok: false, error: d.error || 'PIN incorrecto' };
  } catch {
    return { ok: false, error: 'Sin conexión al servidor' };
  }
}

/* Alias para compatibilidad: admin login */
async function autenticarPin(pin) {
  return login(pin);
}

function getAdminToken() { return _adminToken; }
function getSupervisorToken() { return _supervisorToken; }
function getDeviceId() { return _getDeviceId(); }

function logout() {
  _adminToken = null;
  _supervisorToken = null;
  if (_adminSessionTimer) { clearTimeout(_adminSessionTimer); _adminSessionTimer = null; }
}

function clearSupervisorToken() {
  _supervisorToken = null;
}

/* ── Device token del kiosco (persistente en localStorage) ── */
function getDeviceToken() {
  return localStorage.getItem('device_token') || null;
}

/* ── Autorizar este dispositivo como kiosco (requiere sesión admin activa) ── */
/* nombre: etiqueta descriptiva del kiosco. Devuelve { ok, deviceToken, nuevo, error? } */
async function autorizarDispositivo(nombre) {
  if (!CONFIG.GS_URL) return { ok: false, error: 'Sin URL de servidor' };
  if (!_adminToken) return { ok: false, error: 'Sesión expirada, vuelve a ingresar el PIN' };
  try {
    const deviceId = _getDeviceId();
    const d = await _postGs({ accion: 'autorizarDispositivo', token: _adminToken,
                               deviceId, nombre: nombre || 'Kiosco' });
    if (d.ok && d.deviceToken) {
      localStorage.setItem('device_token', d.deviceToken);
      return { ok: true, deviceToken: d.deviceToken, nuevo: d.nuevo };
    }
    return { ok: false, error: d.error || 'No se pudo autorizar el dispositivo' };
  } catch {
    return { ok: false, error: 'Sin conexión al servidor' };
  }
}

/* ── Cambiar PIN en backend (requiere token de sesión activo + PIN actual) ── */
async function cambiarPin(pinActual, pinNuevo) {
  if (!pinActual || !pinNuevo) return { ok: false, error: 'Ingresa todos los campos' };
  if (!CONFIG.GS_URL) return { ok: false, error: 'Configura la URL del servidor en Ajustes' };
  if (!_adminToken) return { ok: false, error: 'Sesión expirada, vuelve a ingresar el PIN' };
  try {
    const hashActual = await _sha256(String(pinActual));
    const hashNuevo  = await _sha256(String(pinNuevo));
    const d = await _postGs({ accion: 'cambiarPin', token: _adminToken, hashActual, hashNuevo });
    if (d.ok) return { ok: true };
    return { ok: false, error: d.error || 'No se pudo cambiar el PIN' };
  } catch {
    return { ok: false, error: 'Sin conexión al servidor' };
  }
}

/* ── Guardar configuración en backend (requiere token de sesión activo) ── */
async function guardarConfigBackend(cfg) {
  if (!CONFIG.GS_URL) return { ok: false, error: 'Sin URL de servidor' };
  if (!_adminToken) return { ok: false, error: 'Sesión expirada, vuelve a ingresar el PIN' };
  try {
    const d = await _postGs({ accion: 'guardarConfig', token: _adminToken, config: cfg });
    if (d.ok) return { ok: true };
    return { ok: false, error: d.error || 'No se pudo guardar la configuración' };
  } catch {
    return { ok: false, error: 'Sin conexión al servidor' };
  }
}
