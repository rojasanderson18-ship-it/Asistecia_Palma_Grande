/***********************************************************
 * CONTROL DE ASISTENCIA — Backend Google Apps Script v4.0
 *
 * Configuración inicial (ejecutar en el editor de Apps Script):
 *   setPin('XXXX')             — PIN de administrador (4–8 dígitos)
 *   setSupervisorPin('YYYY')   — PIN de supervisor (diferente al admin)
 *   setConfig({ empresa:'Mi Empresa', fincaNombre:'Sede Principal',
 *               lat:4.710989, lng:-74.072092, radio:200 })
 *
 * Endpoints públicos (sin autenticación):
 *   GET  accion=obtenerConfig           — configuración pública de empresa/finca
 *
 * Endpoints de dispositivo autorizado (deviceToken):
 *   POST accion=marcar                  — registrar marcación (servidor valida todo)
 *   POST accion=marcasHoy               — marcaciones del día por documento
 *   POST accion=sincronizarPersonalKiosco — catálogo ligero de personal
 *
 * Endpoints de sesión admin (token 15 min):
 *   POST accion=login                   — iniciar sesión admin
 *   POST accion=loginSupervisor         — iniciar sesión supervisor (token 5 min)
 *   POST accion=cambiarPin              — cambiar PIN (sesión + PIN actual)
 *   POST accion=guardarConfig           — guardar configuración
 *   POST accion=registrarPersonal       — registrar empleado
 *   POST accion=guardarFotoPersonal     — guardar foto de enrolamiento
 *   POST accion=eliminarPersonal        — eliminar empleado
 *   POST accion=listarPersonal          — listar empleados (catálogo completo)
 *   POST accion=resumenDashboard        — resumen del día
 *   POST accion=obtenerFoto             — foto privada de empleado (base64)
 *   POST accion=autorizarDispositivo    — registrar y autorizar kiosco
 *   POST accion=listarDispositivos      — ver dispositivos autorizados
 *   POST accion=revocarDispositivo      — revocar acceso de un kiosco
 ***********************************************************/

const SHEET_ID           = "1ZjIJ_AHty-ltlFDJP_0MV4mIXAhs1oNKhKcYWNMlbC8";
const HOJA_MARCACIONES   = "Marcaciones";
const HOJA_PERSONAL      = "Personal";
const HOJA_DISPOSITIVOS  = "Dispositivos";
const HOJA_AUDITORIA     = "AuditoriaPin";
const CACHE_SESSION_TTL  = 900;   // 15 min sesión admin
const CACHE_SUP_TTL      = 300;   // 5 min sesión supervisor
const CACHE_DEVICE_TTL   = 300;   // 5 min cache de deviceToken validado
const MAX_INTENTOS_PIN   = 5;
const BLOQUEO_SEGUNDOS   = 600;   // 10 min primer bloqueo
const APP_VERSION        = '4.0';

/* ══════════════════════════════════════════════════════
   HELPERS: respuesta JSON
══════════════════════════════════════════════════════ */

function _respuestaJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ══════════════════════════════════════════════════════
   HELPERS: PIN y sesiones administrativas
══════════════════════════════════════════════════════ */

function _verificarPin(hashRecibido) {
  const h = String(hashRecibido || '').toLowerCase().trim();
  if (!h || h.length !== 64) return { ok: false, error: 'hash inválido' };
  const guardado = (PropertiesService.getScriptProperties().getProperty('PIN_HASH') || '').toLowerCase().trim();
  if (!guardado) return { ok: false, error: 'PIN no configurado en servidor' };
  return { ok: h === guardado };
}

function _verificarPinSupervisor(hashRecibido) {
  const h = String(hashRecibido || '').toLowerCase().trim();
  if (!h || h.length !== 64) return { ok: false, error: 'hash inválido' };
  const guardado = (PropertiesService.getScriptProperties().getProperty('SUPERVISOR_PIN_HASH') || '').toLowerCase().trim();
  if (!guardado) return { ok: false, error: 'PIN de supervisor no configurado en servidor' };
  return { ok: h === guardado };
}

function _generarToken() {
  const raw = Utilities.getUuid() + new Date().getTime().toString() + Math.random().toString();
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw)
    .map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); })
    .join('');
}

function _guardarSesion(token, role, ttl) {
  CacheService.getScriptCache().put(
    'SES_' + token,
    JSON.stringify({ role: role, createdAt: new Date().toISOString() }),
    ttl
  );
}

function _validarSesion(token, rolesPermitidos) {
  if (!token) return { ok: false, error: 'Se requiere sesión activa. Vuelve a autenticar.' };
  const raw = CacheService.getScriptCache().get('SES_' + String(token).slice(0, 64));
  if (!raw) return { ok: false, error: 'Sesión expirada. Vuelve a autenticar.' };
  const s = JSON.parse(raw);
  if (rolesPermitidos && rolesPermitidos.indexOf(s.role) === -1)
    return { ok: false, error: 'Acceso no autorizado para este rol.' };
  return { ok: true, role: s.role };
}

/* ══════════════════════════════════════════════════════
   HELPERS: rate limiting (CacheService + auditoría en hoja)
══════════════════════════════════════════════════════ */

function _rlKey(id) {
  return 'RL_' + String(id || 'def').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

function _checkRateLimit(id) {
  const raw = CacheService.getScriptCache().get(_rlKey(id));
  if (!raw) return { blocked: false };
  const d = JSON.parse(raw);
  if (d.blockedUntil && new Date() < new Date(d.blockedUntil))
    return { blocked: true, error: 'Demasiados intentos fallidos. Intenta en 10 minutos.' };
  return { blocked: false, count: d.count || 0 };
}

function _registrarIntentoFallido(id, origen) {
  const cache = CacheService.getScriptCache();
  const key   = _rlKey(id);
  const raw   = cache.get(key);
  const d     = raw ? JSON.parse(raw) : { count: 0 };
  if (d.blockedUntil && new Date() >= new Date(d.blockedUntil)) d.count = 0;
  d.count = (d.count || 0) + 1;
  d.lastAttempt = new Date().toISOString();
  if (d.count >= MAX_INTENTOS_PIN) {
    const minutos = BLOQUEO_SEGUNDOS / 60;
    d.blockedUntil = new Date(Date.now() + BLOQUEO_SEGUNDOS * 1000).toISOString();
    d.count = 0;
    cache.put(key, JSON.stringify(d), BLOQUEO_SEGUNDOS + 120);
  } else {
    cache.put(key, JSON.stringify(d), BLOQUEO_SEGUNDOS + 120);
  }
  _auditarIntento(id, 'FALLIDO', origen || '');
}

function _resetRateLimit(id) {
  CacheService.getScriptCache().remove(_rlKey(id));
}

function _auditarIntento(id, resultado, origen) {
  try {
    const hoja = obtenerOhCrearHojaAuditoria();
    hoja.appendRow([
      Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy HH:mm:ss'),
      String(id).slice(0, 64),
      resultado,
      origen || ''
    ]);
  } catch (e) { /* no bloquear si falla la auditoría */ }
}

/* ══════════════════════════════════════════════════════
   HELPERS: dispositivos autorizados
══════════════════════════════════════════════════════ */

function _generarDeviceToken() {
  const raw = Utilities.getUuid() + new Date().getTime().toString() + Math.random().toString() + 'kiosco';
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw)
    .map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); })
    .join('');
}

// Devuelve {ok, deviceId, nombre, empresa, finca} o {ok:false, error}
// Usa CacheService para no leer la hoja en cada marcación
function _validarDeviceToken(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string' || deviceToken.length < 32) {
    return { ok: false, error: 'Dispositivo no autorizado.' };
  }
  const tok = String(deviceToken).slice(0, 64);
  const cacheKey = 'DEV_' + tok;
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) {
    const c = JSON.parse(cached);
    if (c.ok) return c;
    return { ok: false, error: 'Dispositivo no autorizado.' };
  }
  const hoja  = obtenerOhCrearHojaDispositivos();
  const datos = hoja.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    const [deviceId, dToken, nombre, empresa, finca, estado] = datos[i];
    if (String(dToken).trim() === tok) {
      if (String(estado).trim().toLowerCase() !== 'activo') {
        CacheService.getScriptCache().put(cacheKey, JSON.stringify({ ok: false }), CACHE_DEVICE_TTL);
        return { ok: false, error: 'Dispositivo inactivo. Contacta al administrador.' };
      }
      const result = { ok: true, deviceId: String(deviceId).trim(), nombre: String(nombre).trim(),
                       empresa: String(empresa).trim(), finca: String(finca).trim(), row: i + 1 };
      CacheService.getScriptCache().put(cacheKey, JSON.stringify(result), CACHE_DEVICE_TTL);
      return result;
    }
  }
  CacheService.getScriptCache().put(cacheKey, JSON.stringify({ ok: false }), CACHE_DEVICE_TTL);
  return { ok: false, error: 'Dispositivo no autorizado.' };
}

function _actualizarUltimaConexion(deviceToken) {
  // Solo actualizar en hoja si el cache indica que hay que hacerlo (cada ~5 min)
  const flagKey = 'DEVUPD_' + String(deviceToken).slice(0, 32);
  if (CacheService.getScriptCache().get(flagKey)) return;
  try {
    const hoja  = obtenerOhCrearHojaDispositivos();
    const datos = hoja.getDataRange().getValues();
    const tok   = String(deviceToken).slice(0, 64);
    for (let i = 1; i < datos.length; i++) {
      if (String(datos[i][1]).trim() === tok) {
        hoja.getRange(i + 1, 8).setValue(new Date());
        SpreadsheetApp.flush();
        break;
      }
    }
    CacheService.getScriptCache().put(flagKey, '1', CACHE_DEVICE_TTL);
  } catch (e) { /* no bloquear marcación si falla la actualización */ }
}

/* ══════════════════════════════════════════════════════
   HELPERS: sanitización y hojas
══════════════════════════════════════════════════════ */

function sanitizarCelda(valor) {
  if (typeof valor !== 'string') return valor;
  return /^[=+\-@\t]/.test(valor) ? "'" + valor : valor;
}

function obtenerOhCrearHoja() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  let hoja   = ss.getSheetByName(HOJA_MARCACIONES);
  if (!hoja) {
    hoja = ss.insertSheet(HOJA_MARCACIONES);
    hoja.appendRow(['Fecha','Hora','Nombre','Documento','Cargo','Finca','Tipo',
                    'Lat','Lng','DentroGeocerca','DistanciaFacial','Timestamp',
                    'DeviceId','PrecisionGPS','AppVersion','ModoOffline','ResultadoFacial']);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function obtenerOhCrearHojaPersonal() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  let hoja   = ss.getSheetByName(HOJA_PERSONAL);
  if (!hoja) {
    hoja = ss.insertSheet(HOJA_PERSONAL);
    hoja.appendRow(['Documento','Nombre','Cargo','Fecha registro','FotoId']);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function obtenerOhCrearHojaDispositivos() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  let hoja   = ss.getSheetByName(HOJA_DISPOSITIVOS);
  if (!hoja) {
    hoja = ss.insertSheet(HOJA_DISPOSITIVOS);
    hoja.appendRow(['DeviceId','DeviceToken','Nombre','Empresa','Finca','Estado','FechaRegistro','UltimaConexion']);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function obtenerOhCrearHojaAuditoria() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  let hoja   = ss.getSheetByName(HOJA_AUDITORIA);
  if (!hoja) {
    hoja = ss.insertSheet(HOJA_AUDITORIA);
    hoja.appendRow(['FechaHora','DeviceId','Resultado','Origen']);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function obtenerOhCrearCarpetaFotos() {
  const carpetas = DriveApp.getFoldersByName('Fotos_Asistencia');
  if (carpetas.hasNext()) return carpetas.next();
  return DriveApp.createFolder('Fotos_Asistencia');
}

/* ══════════════════════════════════════════════════════
   HELPERS: fotos en Drive (privadas)
══════════════════════════════════════════════════════ */

function guardarFoto(fotoDataUrl, documento, tipo) {
  if (!fotoDataUrl) return '';
  try {
    const partes  = String(fotoDataUrl).split(',');
    const base64  = partes.length > 1 ? partes[1] : partes[0];
    const bytes   = Utilities.base64Decode(base64);
    const nombre  = (documento || 'sin-doc') + '_' + (tipo || '') + '_' + Date.now() + '.jpg';
    const blob    = Utilities.newBlob(bytes, 'image/jpeg', nombre);
    const carpeta = obtenerOhCrearCarpetaFotos();
    const archivo = carpeta.createFile(blob);
    // Sin acceso público — las fotos se sirven únicamente mediante POST obtenerFoto (autenticado)
    return archivo.getId();
  } catch (err) {
    Logger.log('Error guardando foto: ' + err.message);
    throw err;
  }
}

function borrarFotoAnterior(fotoIdOUrl) {
  if (!fotoIdOUrl) return;
  try {
    let id = String(fotoIdOUrl);
    if (id.startsWith('https://')) {
      const m = id.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (!m) return;
      id = m[1];
    }
    DriveApp.getFileById(id).setTrashed(true);
  } catch (e) { /* archivo ya eliminado o sin permisos */ }
}

function guardarFotoPersonal_(documento, fotoDataUrl, nombre, cargo) {
  const hoja  = obtenerOhCrearHojaPersonal();
  const datos = hoja.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    if (String(datos[i][0]).trim() === String(documento).trim()) {
      borrarFotoAnterior(datos[i][4]);
      const fotoId = guardarFoto(fotoDataUrl, documento, 'Enrolamiento');
      hoja.getRange(i + 1, 5).setValue(fotoId);
      if (nombre) hoja.getRange(i + 1, 2).setValue(sanitizarCelda(nombre));
      if (cargo)  hoja.getRange(i + 1, 3).setValue(sanitizarCelda(cargo));
      SpreadsheetApp.flush();
      return fotoId;
    }
  }
  const fotoId = guardarFoto(fotoDataUrl, documento, 'Enrolamiento');
  hoja.appendRow([sanitizarCelda(String(documento)), sanitizarCelda(nombre || ''),
                  sanitizarCelda(cargo || ''), new Date(), fotoId]);
  SpreadsheetApp.flush();
  return fotoId;
}

function obtenerFotosPorDocumento() {
  const hoja  = obtenerOhCrearHojaPersonal();
  const datos = hoja.getDataRange().getValues();
  const fotos = {};
  for (let i = 1; i < datos.length; i++) {
    if (datos[i][4]) fotos[String(datos[i][0])] = datos[i][4];
  }
  return fotos;
}

/* ══════════════════════════════════════════════════════
   HELPERS: personal y marcaciones
══════════════════════════════════════════════════════ */

// Busca un empleado activo por documento. Devuelve {ok, nombre, cargo} o {ok:false}
function _buscarEmpleado(documento) {
  const doc   = String(documento || '').trim();
  if (!doc) return { ok: false, error: 'Documento requerido' };
  const hoja  = obtenerOhCrearHojaPersonal();
  const datos = hoja.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    if (String(datos[i][0]).trim() === doc) {
      return { ok: true, nombre: String(datos[i][1]).trim(), cargo: String(datos[i][2]).trim() };
    }
  }
  return { ok: false, error: 'Empleado no registrado' };
}

function normalizarFecha(valor) {
  if (Object.prototype.toString.call(valor) === '[object Date]')
    return Utilities.formatDate(valor, 'America/Bogota', 'dd/MM/yyyy');
  return String(valor);
}

function normalizarHora(valor) {
  if (Object.prototype.toString.call(valor) === '[object Date]')
    return Utilities.formatDate(valor, 'America/Bogota', 'HH:mm:ss');
  return String(valor);
}

// Devuelve array de tipos de marcación para el documento en la fecha dada (dd/MM/yyyy)
function _obtenerMarcasDelDia(documento, fechaStr) {
  const doc  = String(documento || '').trim();
  const hoja = obtenerOhCrearHoja();
  const datos = hoja.getDataRange().getValues();
  const marcas = [];
  for (let i = 1; i < datos.length; i++) {
    const [fecha, , , docFila, , , tipo] = datos[i];
    if (normalizarFecha(fecha) === fechaStr && String(docFila).trim() === doc)
      marcas.push(String(tipo).trim());
  }
  return marcas;
}

// Valida la secuencia de marcaciones. Devuelve {ok, error?}
function _validarSecuencia(marcasExistentes, tipoNuevo) {
  const tipo = String(tipoNuevo || '').trim();
  if (tipo !== 'Entrada' && tipo !== 'Salida')
    return { ok: false, error: 'Tipo de marcación inválido. Solo se acepta Entrada o Salida.' };
  const entradas = marcasExistentes.filter(function(t) { return t === 'Entrada'; }).length;
  const salidas  = marcasExistentes.filter(function(t) { return t === 'Salida'; }).length;
  if (tipo === 'Entrada') {
    if (entradas >= 1) return { ok: false, error: 'Ya existe una Entrada registrada hoy.' };
  } else {
    if (entradas === 0) return { ok: false, error: 'No hay Entrada registrada. Registra la Entrada primero.' };
    if (salidas >= 1)   return { ok: false, error: 'Ya existe una Salida registrada hoy. Jornada completa.' };
  }
  return { ok: true };
}

// Calcula distancia Haversine en metros
function _haversine(lat1, lng1, lat2, lng2) {
  const R    = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) * Math.sin(dLat / 2)
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Calcula si las coordenadas están dentro de la geocerca configurada en el backend
function _calcularGeocerca(lat, lng) {
  try {
    const props  = PropertiesService.getScriptProperties();
    const raw    = props.getProperty('APP_CONFIG');
    if (!raw) return { dentroGeocerca: false, distancia: null, sinConfig: true };
    const cfg    = JSON.parse(raw);
    const cLat   = parseFloat(cfg.lat);
    const cLng   = parseFloat(cfg.lng);
    const radio  = parseInt(cfg.radio) || 200;
    if (isNaN(cLat) || isNaN(cLng)) return { dentroGeocerca: false, distancia: null, sinConfig: true };
    const dist = _haversine(parseFloat(lat), parseFloat(lng), cLat, cLng);
    return { dentroGeocerca: dist <= radio, distancia: Math.round(dist) };
  } catch (e) {
    return { dentroGeocerca: false, distancia: null, sinConfig: true };
  }
}

/* ══════════════════════════════════════════════════════
   doPost — punto de entrada para todos los POST
══════════════════════════════════════════════════════ */

function doPost(e) {
  try {
    const datos  = JSON.parse(e.postData.contents);
    const accion = String(datos.accion || '').trim();

    /* ── Login admin ── */
    if (accion === 'login') {
      const deviceId = String(datos.deviceId || 'unknown').slice(0, 64);
      const rl = _checkRateLimit(deviceId);
      if (rl.blocked) return _respuestaJson({ ok: false, error: rl.error });
      const v = _verificarPin(datos.hash);
      if (!v.ok) {
        _registrarIntentoFallido(deviceId, 'login-admin');
        return _respuestaJson({ ok: false, error: v.error });
      }
      _resetRateLimit(deviceId);
      _auditarIntento(deviceId, 'OK-ADMIN', 'login-admin');
      const token = _generarToken();
      _guardarSesion(token, 'admin', CACHE_SESSION_TTL);
      return _respuestaJson({ ok: true, token: token, role: 'admin', expiresIn: CACHE_SESSION_TTL });
    }

    /* ── Login supervisor ── */
    if (accion === 'loginSupervisor') {
      const deviceId = String(datos.deviceId || 'unknown').slice(0, 64) + '_sup';
      const rl = _checkRateLimit(deviceId);
      if (rl.blocked) return _respuestaJson({ ok: false, error: rl.error });
      const v = _verificarPinSupervisor(datos.hash);
      if (!v.ok) {
        _registrarIntentoFallido(deviceId, 'login-supervisor');
        return _respuestaJson({ ok: false, error: v.error });
      }
      _resetRateLimit(deviceId);
      _auditarIntento(deviceId, 'OK-SUPERVISOR', 'login-supervisor');
      const token = _generarToken();
      _guardarSesion(token, 'supervisor', CACHE_SUP_TTL);
      return _respuestaJson({ ok: true, token: token, role: 'supervisor', expiresIn: CACHE_SUP_TTL });
    }

    /* ── Cambiar PIN (requiere sesión admin + PIN actual) ── */
    if (accion === 'cambiarPin') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const vActual = _verificarPin(datos.hashActual);
      if (!vActual.ok) return _respuestaJson({ ok: false, error: vActual.error || 'PIN actual incorrecto' });
      const hashNuevo = String(datos.hashNuevo || '').toLowerCase().trim();
      if (!hashNuevo || hashNuevo.length !== 64) return _respuestaJson({ ok: false, error: 'hash inválido' });
      PropertiesService.getScriptProperties().setProperty('PIN_HASH', hashNuevo);
      return _respuestaJson({ ok: true });
    }

    /* ── Guardar configuración (requiere sesión admin) ── */
    if (accion === 'guardarConfig') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const cfg = datos.config || {};
      const permitidos = ['empresa','fincaNombre','fincaId','lat','lng','radio','entrada','salida','salidaSab','umbral'];
      const seguro = {};
      permitidos.forEach(function(k) { if (cfg[k] != null) seguro[k] = cfg[k]; });
      PropertiesService.getScriptProperties().setProperty('APP_CONFIG', JSON.stringify(seguro));
      return _respuestaJson({ ok: true });
    }

    /* ── Registrar personal (requiere sesión admin) ── */
    if (accion === 'registrarPersonal') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const hojaPersonal = obtenerOhCrearHojaPersonal();
      const existentes   = hojaPersonal.getDataRange().getValues();
      const docNuevo     = String(datos.documento || '').trim();
      if (!docNuevo || !/^\d+$/.test(docNuevo)) return _respuestaJson({ ok: false, error: 'Documento inválido' });
      for (let i = 1; i < existentes.length; i++) {
        if (String(existentes[i][0]).trim() === docNuevo)
          return _respuestaJson({ ok: false, error: 'Ya existe una persona con ese documento' });
      }
      hojaPersonal.appendRow([sanitizarCelda(docNuevo), sanitizarCelda(datos.nombre),
                               sanitizarCelda(datos.cargo), new Date(), '']);
      SpreadsheetApp.flush();
      // Invalidar cache de personal kiosco
      CacheService.getScriptCache().remove('PERSONAL_KIOSCO');
      return _respuestaJson({ ok: true });
    }

    /* ── Guardar foto de enrolamiento (requiere sesión admin) ── */
    if (accion === 'guardarFotoPersonal') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      guardarFotoPersonal_(datos.documento, datos.foto, datos.nombre, datos.cargo);
      return _respuestaJson({ ok: true });
    }

    /* ── Eliminar personal (requiere sesión admin) ── */
    if (accion === 'eliminarPersonal') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const hoja  = obtenerOhCrearHojaPersonal();
      const filas = hoja.getDataRange().getValues();
      const doc   = String(datos.documento || '').trim();
      for (let i = 1; i < filas.length; i++) {
        if (String(filas[i][0]).trim() === doc) {
          borrarFotoAnterior(filas[i][4]);
          hoja.deleteRow(i + 1);
          SpreadsheetApp.flush();
          CacheService.getScriptCache().remove('PERSONAL_KIOSCO');
          return _respuestaJson({ ok: true });
        }
      }
      return _respuestaJson({ ok: false, error: 'Empleado no encontrado' });
    }

    /* ── Listar personal completo (requiere sesión admin) ── */
    if (accion === 'listarPersonal') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const hoja  = obtenerOhCrearHojaPersonal();
      const filas = hoja.getDataRange().getValues();
      const personal = [];
      for (let i = 1; i < filas.length; i++) {
        const [doc, nombre, cargo] = filas[i];
        if (doc && nombre) personal.push({
          documento: String(doc).trim(), nombre: String(nombre).trim(), cargo: String(cargo || '').trim()
        });
      }
      return _respuestaJson({ ok: true, personal: personal });
    }

    /* ── Foto de empleado (requiere sesión admin o supervisor) ── */
    if (accion === 'obtenerFoto') {
      const sv = _validarSesion(datos.token, ['admin', 'supervisor']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const documento = String(datos.documento || '').trim();
      if (!documento) return _respuestaJson({ ok: false, error: 'documento requerido' });
      const fotos  = obtenerFotosPorDocumento();
      const fotoId = fotos[documento];
      if (!fotoId) return _respuestaJson({ ok: false, error: 'Sin foto registrada' });
      try {
        let id = String(fotoId);
        if (id.startsWith('https://')) {
          const m = id.match(/[?&]id=([a-zA-Z0-9_-]+)/);
          if (!m) return _respuestaJson({ ok: false, error: 'Formato de foto no reconocido' });
          id = m[1];
        }
        const file = DriveApp.getFileById(id);
        const blob = file.getBlob();
        return _respuestaJson({ ok: true, b64: Utilities.base64Encode(blob.getBytes()), mimeType: blob.getContentType() });
      } catch (ex) {
        return _respuestaJson({ ok: false, error: 'No se pudo obtener la foto' });
      }
    }

    /* ── Resumen dashboard (requiere sesión admin) ── */
    if (accion === 'resumenDashboard') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      return calcularResumenDashboard(datos.fecha, datos.finca);
    }

    /* ── Autorizar dispositivo kiosco (requiere sesión admin) ── */
    if (accion === 'autorizarDispositivo') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const deviceId = String(datos.deviceId || '').trim().slice(0, 64);
      if (!deviceId) return _respuestaJson({ ok: false, error: 'deviceId requerido' });
      const props   = PropertiesService.getScriptProperties();
      const cfgRaw  = props.getProperty('APP_CONFIG') || '{}';
      const cfg     = JSON.parse(cfgRaw);
      const empresa = cfg.empresa || '';
      const finca   = cfg.fincaNombre || '';
      const nombre  = String(datos.nombre || 'Kiosco').trim().slice(0, 60);
      // Verificar si ya existe
      const hoja  = obtenerOhCrearHojaDispositivos();
      const filas = hoja.getDataRange().getValues();
      for (let i = 1; i < filas.length; i++) {
        if (String(filas[i][0]).trim() === deviceId) {
          // Ya existe — reactivar si estaba inactivo
          if (String(filas[i][5]).trim().toLowerCase() !== 'activo') {
            hoja.getRange(i + 1, 6).setValue('activo');
            SpreadsheetApp.flush();
          }
          const existingToken = String(filas[i][1]).trim();
          CacheService.getScriptCache().remove('DEV_' + existingToken);
          return _respuestaJson({ ok: true, deviceToken: existingToken, nuevo: false });
        }
      }
      const deviceToken = _generarDeviceToken();
      hoja.appendRow([deviceId, deviceToken, nombre, empresa, finca, 'activo', new Date(), new Date()]);
      SpreadsheetApp.flush();
      return _respuestaJson({ ok: true, deviceToken: deviceToken, nuevo: true });
    }

    /* ── Listar dispositivos (requiere sesión admin) ── */
    if (accion === 'listarDispositivos') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const hoja  = obtenerOhCrearHojaDispositivos();
      const filas = hoja.getDataRange().getValues();
      const dispositivos = [];
      for (let i = 1; i < filas.length; i++) {
        const [deviceId, , nombre, empresa, finca, estado, fechaRegistro, ultimaConexion] = filas[i];
        if (deviceId) dispositivos.push({
          deviceId: String(deviceId).trim(), nombre: String(nombre).trim(),
          empresa: String(empresa).trim(), finca: String(finca).trim(),
          estado: String(estado).trim(),
          fechaRegistro: normalizarFecha(fechaRegistro), ultimaConexion: normalizarFecha(ultimaConexion)
        });
      }
      return _respuestaJson({ ok: true, dispositivos: dispositivos });
    }

    /* ── Revocar dispositivo (requiere sesión admin) ── */
    if (accion === 'revocarDispositivo') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const deviceId = String(datos.deviceId || '').trim();
      const hoja  = obtenerOhCrearHojaDispositivos();
      const filas = hoja.getDataRange().getValues();
      for (let i = 1; i < filas.length; i++) {
        if (String(filas[i][0]).trim() === deviceId) {
          hoja.getRange(i + 1, 6).setValue('inactivo');
          SpreadsheetApp.flush();
          const tok = String(filas[i][1]).trim();
          CacheService.getScriptCache().remove('DEV_' + tok);
          return _respuestaJson({ ok: true });
        }
      }
      return _respuestaJson({ ok: false, error: 'Dispositivo no encontrado' });
    }

    /* ── Sincronizar personal (requiere deviceToken de kiosco autorizado) ── */
    if (accion === 'sincronizarPersonalKiosco') {
      const dv = _validarDeviceToken(datos.deviceToken);
      if (!dv.ok) return _respuestaJson({ ok: false, error: dv.error });
      _actualizarUltimaConexion(datos.deviceToken);
      // Cache del catálogo para no leer la hoja en cada arranque
      const cacheKey = 'PERSONAL_KIOSCO';
      const cached   = CacheService.getScriptCache().get(cacheKey);
      let personal;
      if (cached) {
        personal = JSON.parse(cached);
      } else {
        const hoja  = obtenerOhCrearHojaPersonal();
        const filas = hoja.getDataRange().getValues();
        personal = [];
        for (let i = 1; i < filas.length; i++) {
          const [doc, nombre, cargo] = filas[i];
          if (doc && nombre) personal.push({
            documento: String(doc).trim(), nombre: String(nombre).trim(),
            cargo: String(cargo || '').trim(), activo: true
          });
        }
        try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(personal), 300); } catch (e) {}
      }
      return _respuestaJson({ ok: true, personal: personal, version: new Date().getTime() });
    }

    /* ── Marcas del día (requiere deviceToken de kiosco autorizado) ── */
    if (accion === 'marcasHoy') {
      const dv = _validarDeviceToken(datos.deviceToken);
      if (!dv.ok) return _respuestaJson({ ok: false, error: dv.error });
      const documento = String(datos.documento || '').trim();
      if (!documento) return _respuestaJson({ ok: false, error: 'documento requerido' });
      const hoy    = Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy');
      const marcas = _obtenerMarcasDelDia(documento, hoy);
      return _respuestaJson({ ok: true, marcas: marcas });
    }

    /* ── Marcación de asistencia (requiere deviceToken de kiosco autorizado) ── */
    if (accion === 'marcar') {
      const dv = _validarDeviceToken(datos.deviceToken);
      if (!dv.ok) return _respuestaJson({ ok: false, error: dv.error });

      // Validar tipo antes de cualquier operación costosa
      const tipo = String(datos.tipo || '').trim();
      if (tipo !== 'Entrada' && tipo !== 'Salida')
        return _respuestaJson({ ok: false, error: 'Tipo inválido. Solo se acepta Entrada o Salida.' });

      // Validar que el documento exista en Personal
      const documento = String(datos.documento || '').trim();
      const empleado  = _buscarEmpleado(documento);
      if (!empleado.ok) return _respuestaJson({ ok: false, error: empleado.error });

      // Fecha y hora del SERVIDOR (no del cliente)
      const ahoraServidor = new Date();
      const hoyStr = Utilities.formatDate(ahoraServidor, 'America/Bogota', 'dd/MM/yyyy');
      const horaStr = Utilities.formatDate(ahoraServidor, 'America/Bogota', 'HH:mm:ss');

      // Verificar secuencia de marcaciones del día
      const marcasHoy = _obtenerMarcasDelDia(documento, hoyStr);
      const sv = _validarSecuencia(marcasHoy, tipo);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });

      // Geocerca calculada en el backend (ignorar dentroGeocerca del frontend)
      const lat = parseFloat(datos.lat);
      const lng = parseFloat(datos.lng);
      let dentroGeocerca = false;
      let distanciaMetros = null;
      if (!isNaN(lat) && !isNaN(lng)) {
        const geo = _calcularGeocerca(lat, lng);
        dentroGeocerca  = geo.dentroGeocerca;
        distanciaMetros = geo.distancia;
      }

      // Nombre, cargo y finca vienen del backend, no del payload
      const nombre = empleado.nombre;
      const cargo  = empleado.cargo;
      const cfg    = (function() {
        try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('APP_CONFIG') || '{}'); }
        catch (e) { return {}; }
      })();
      const finca  = cfg.fincaNombre || dv.finca || '';

      const hoja = obtenerOhCrearHoja();
      hoja.appendRow([
        hoyStr, horaStr,
        sanitizarCelda(nombre),
        sanitizarCelda(documento),
        sanitizarCelda(cargo),
        sanitizarCelda(finca),
        tipo,
        isNaN(lat) ? '' : lat,
        isNaN(lng) ? '' : lng,
        dentroGeocerca ? 'SI' : 'NO',
        datos.distanciaFacial != null ? parseFloat(datos.distanciaFacial).toFixed(3) : '',
        ahoraServidor,
        sanitizarCelda(dv.deviceId),
        datos.precisionGPS != null ? parseFloat(datos.precisionGPS).toFixed(1) : '',
        sanitizarCelda(String(datos.appVersion || '')),
        datos.sinConexion ? 'OFFLINE' : 'ONLINE',
        datos.sinBiometria ? 'SUPERVISOR' : (datos.distanciaFacial != null ? 'FACIAL' : 'SIN_BIOMETRIA')
      ]);
      SpreadsheetApp.flush();

      _actualizarUltimaConexion(datos.deviceToken);

      if (tipo === 'Salida') {
        try { calcularResumenDiario(); } catch (e) { Logger.log('calcularResumenDiario: ' + e.message); }
      }

      return _respuestaJson({ ok: true, nombre: nombre, cargo: cargo, finca: finca,
                              dentroGeocerca: dentroGeocerca, distanciaMetros: distanciaMetros,
                              horaServidor: horaStr });
    }

    /* ── Acción desconocida: rechazar explícitamente ── */
    return _respuestaJson({ ok: false, error: 'Acción no reconocida: ' + accion });

  } catch (err) {
    return _respuestaJson({ ok: false, error: err.message });
  }
}

/* ══════════════════════════════════════════════════════
   doGet — solo endpoints públicos y de salud
══════════════════════════════════════════════════════ */

function doGet(e) {
  const accion = e.parameter && e.parameter.accion;

  /* ── Configuración pública (sin datos personales, sin auth) ── */
  if (accion === 'obtenerConfig') {
    const props = PropertiesService.getScriptProperties();
    let config  = {};
    try { const raw = props.getProperty('APP_CONFIG'); if (raw) config = JSON.parse(raw); } catch (ex) {}
    return _respuestaJson({ ok: true, config: config });
  }

  /* ── Health check ── */
  return _respuestaJson({ status: 'Control_Asistencia v' + APP_VERSION + ' activo' });
}

/* ══════════════════════════════════════════════════════
   REPORTES Y RESUMEN DIARIO
══════════════════════════════════════════════════════ */

function calcularResumenDashboard(fechaParam, fincaFiltro) {
  const hoy   = Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy');
  const fecha = fechaParam || hoy;
  const hoja  = obtenerOhCrearHoja();
  const datos = hoja.getDataRange().getValues();
  const cfg   = (function() {
    try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('APP_CONFIG') || '{}'); }
    catch (e) { return {}; }
  })();
  const HORA_TOLERANCIA_ENTRADA = (cfg.entrada || 6.0) + 0.25;
  const porPersona = {};

  for (let i = 1; i < datos.length; i++) {
    const [fechaFila, hora, nombre, documento, cargo, finca, tipo] = datos[i];
    if (normalizarFecha(fechaFila) !== fecha) continue;
    if (fincaFiltro && String(finca) !== String(fincaFiltro)) continue;
    const clave = String(documento);
    if (!porPersona[clave]) porPersona[clave] = { nombre: nombre, cargo: cargo, finca: finca };
    porPersona[clave][tipo] = normalizarHora(hora);
  }

  let tardanzas = 0, jornadasCompletas = 0, totalHoras = 0;
  const porFinca = {}, filas = [];

  const horaADecimal = function(hStr) {
    const partes = String(hStr).split(':').map(Number);
    return partes[0] + partes[1] / 60 + (partes[2] || 0) / 3600;
  };

  Object.keys(porPersona).forEach(function(documento) {
    const p = porPersona[documento];
    porFinca[p.finca] = (porFinca[p.finca] || 0) + 1;
    if (p.Entrada) {
      if (horaADecimal(p.Entrada) > HORA_TOLERANCIA_ENTRADA) tardanzas++;
    }
    let horasLaboradas = '';
    if (p.Entrada && p.Salida) {
      jornadasCompletas++;
      const hd = horaADecimal(p.Salida) - horaADecimal(p.Entrada);
      totalHoras += hd;
      horasLaboradas = Math.floor(hd) + 'h ' + Math.round((hd - Math.floor(hd)) * 60) + 'm';
    }
    filas.push({ documento: documento, nombre: p.nombre, cargo: p.cargo, finca: p.finca,
                 entrada: p.Entrada || '', salida: p.Salida || '', horasLaboradas: horasLaboradas });
  });

  return _respuestaJson({
    ok: true, fecha: fecha, totalPersonas: Object.keys(porPersona).length,
    tardanzas: tardanzas, jornadasCompletas: jornadasCompletas,
    totalHoras: totalHoras.toFixed(1), porFinca: porFinca, filas: filas
  });
}

function obtenerOhCrearHojaResumen() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  let hoja   = ss.getSheetByName('Resumen');
  if (!hoja) {
    hoja = ss.insertSheet('Resumen');
    hoja.appendRow(['Fecha','Nombre','Documento','Cargo','Finca','Entrada','Salida',
                    'Horas trabajadas','Déficit (min)','Extra (min)']);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function calcularResumenDiario() {
  const hoja  = obtenerOhCrearHoja();
  const datos = hoja.getDataRange().getValues();
  const hoy   = Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy');
  const cfg   = (function() {
    try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('APP_CONFIG') || '{}'); }
    catch (e) { return {}; }
  })();
  const HORARIO = {
    entrada:      cfg.entrada      || 6.0,
    salida:       cfg.salida       || 14.75,
    salidaSabado: cfg.salidaSab    || 11.75
  };
  const marcasHoy = {};

  for (let i = 1; i < datos.length; i++) {
    const [fecha, hora, nombre, documento, cargo, finca, tipo] = datos[i];
    if (normalizarFecha(fecha) !== hoy) continue;
    const clave = String(documento);
    if (!marcasHoy[clave]) marcasHoy[clave] = { nombre: nombre, cargo: cargo, finca: finca };
    marcasHoy[clave][tipo] = normalizarHora(hora);
  }

  const horaADecimal = function(hStr) {
    const p = hStr.split(':').map(Number); return p[0] + p[1] / 60 + (p[2] || 0) / 3600;
  };
  const filasNuevas = [];
  Object.keys(marcasHoy).forEach(function(doc) {
    const m = marcasHoy[doc];
    if (!m['Entrada'] || !m['Salida']) {
      filasNuevas.push([hoy, m.nombre, doc, m.cargo || '', m.finca, m['Entrada'] || '', m['Salida'] || '', 'INCOMPLETO', '', '']);
      return;
    }
    const entrada    = horaADecimal(m['Entrada']);
    const salida     = horaADecimal(m['Salida']);
    const esSabado   = new Date().getDay() === 6;
    const horaCierre = esSabado ? HORARIO.salidaSabado : HORARIO.salida;
    const horasTrab  = salida - entrada;
    const deficitMin = Math.max(0, (HORARIO.entrada - entrada) * 60) + Math.max(0, (horaCierre - salida) * 60);
    const extraMin   = Math.max(0, (salida - horaCierre) * 60);
    filasNuevas.push([hoy, m.nombre, doc, m.cargo || '', m.finca, m['Entrada'], m['Salida'],
                      horasTrab.toFixed(2), deficitMin.toFixed(0), extraMin.toFixed(0)]);
  });

  const hojaResumen = obtenerOhCrearHojaResumen();
  const existentes  = hojaResumen.getDataRange().getValues();
  for (let i = existentes.length - 1; i >= 1; i--) {
    if (normalizarFecha(existentes[i][0]) === hoy) hojaResumen.deleteRow(i + 1);
  }
  if (filasNuevas.length) {
    hojaResumen.getRange(hojaResumen.getLastRow() + 1, 1, filasNuevas.length, filasNuevas[0].length)
               .setValues(filasNuevas);
  }
}

/* ══════════════════════════════════════════════════════
   UTILIDADES — ejecutar manualmente en el editor
══════════════════════════════════════════════════════ */

/** Configura el PIN de administrador. Ejemplo: setPin('1234') */
function setPin(pin) {
  if (!pin || !/^\d{4,8}$/.test(String(pin))) throw new Error('PIN: 4–8 dígitos');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pin))
    .map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
  PropertiesService.getScriptProperties().setProperty('PIN_HASH', hash);
  Logger.log('PIN admin configurado. Hash: ' + hash);
}

/** Configura el PIN de supervisor. Ejemplo: setSupervisorPin('5678') */
function setSupervisorPin(pin) {
  if (!pin || !/^\d{4,8}$/.test(String(pin))) throw new Error('PIN: 4–8 dígitos');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pin))
    .map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
  PropertiesService.getScriptProperties().setProperty('SUPERVISOR_PIN_HASH', hash);
  Logger.log('PIN supervisor configurado.');
}

/** Configura los parámetros de la empresa. */
function setConfig(config) {
  const permitidos = ['empresa','fincaNombre','fincaId','lat','lng','radio','entrada','salida','salidaSab','umbral'];
  const seguro = {};
  permitidos.forEach(function(k) { if (config[k] != null) seguro[k] = config[k]; });
  PropertiesService.getScriptProperties().setProperty('APP_CONFIG', JSON.stringify(seguro));
  Logger.log('Config guardada: ' + JSON.stringify(seguro));
}

/**
 * Migra fotos antiguas (URLs públicas de Drive) a archivos privados.
 * Ejecutar manualmente desde el editor de Apps Script.
 * Genera un reporte en el log.
 */
function migrarFotosAPrivadas() {
  const hoja  = obtenerOhCrearHojaPersonal();
  const datos = hoja.getDataRange().getValues();
  let migradas = 0, fallidas = 0, yaPrivadas = 0;
  const reporte = [];

  for (let i = 1; i < datos.length; i++) {
    const [doc, nombre, , , fotoIdOUrl] = datos[i];
    const val = String(fotoIdOUrl || '').trim();
    if (!val) continue;

    // Si no es una URL pública, ya es un file ID privado
    if (!val.startsWith('https://')) { yaPrivadas++; continue; }

    // Extraer file ID de la URL pública antigua
    const m = val.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (!m) {
      reporte.push('ERROR (URL sin ID): doc=' + doc + ' url=' + val);
      fallidas++;
      continue;
    }
    const fileId = m[1];
    try {
      const file = DriveApp.getFileById(fileId);
      // Quitar acceso público (establecer acceso privado al propietario)
      file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      // Guardar solo el file ID en la columna E
      hoja.getRange(i + 1, 5).setValue(fileId);
      migradas++;
      reporte.push('OK: doc=' + String(doc) + ' nombre=' + String(nombre) + ' fileId=' + fileId);
    } catch (ex) {
      reporte.push('ERROR: doc=' + String(doc) + ' url=' + val + ' err=' + ex.message);
      fallidas++;
    }
  }

  if (migradas > 0) SpreadsheetApp.flush();

  Logger.log('=== Migración de fotos ===');
  Logger.log('Ya privadas (file ID): ' + yaPrivadas);
  Logger.log('Migradas: ' + migradas);
  Logger.log('Fallidas: ' + fallidas);
  reporte.forEach(function(l) { Logger.log(l); });
  return { yaPrivadas: yaPrivadas, migradas: migradas, fallidas: fallidas, reporte: reporte };
}
