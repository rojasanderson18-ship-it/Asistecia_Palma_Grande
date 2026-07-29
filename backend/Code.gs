/***********************************************************
 * CONTROL DE ASISTENCIA — Backend Google Apps Script v4.0
 *
 * ── Configuración inicial obligatoria (ejecutar UNA VEZ en el editor
 *    de Apps Script, seleccionando la función en el desplegable y
 *    presionando "Ejecutar" — nunca se guarda nada de esto en el repo) ──
 *
 *   setSheetId('TU_ID_DE_GOOGLE_SHEET')
 *       — Enlaza este script a tu Google Sheet. Toma el ID de la URL:
 *         https://docs.google.com/spreadsheets/d/ESTE_ES_EL_ID/edit
 *         Si no se configura, se usa el ID de referencia del proyecto
 *         original como fallback (ver más abajo) — configúralo antes
 *         de operar con datos reales, cada instalación debe tener su
 *         propio Sheet.
 *
 *   setPin('XXXX')             — PIN de administrador (4–8 dígitos)
 *   setSupervisorPin('YYYY')   — PIN de supervisor (diferente al admin)
 *   setConfig({ empresa:'Mi Empresa', fincaNombre:'Sede Principal',
 *               lat:4.710989, lng:-74.072092, radio:200 })
 *
 * ── Clasificación de endpoints por nivel de acceso ──
 *
 * Endpoints públicos (sin autenticación — accesibles por cualquiera con la URL):
 *   GET  accion=obtenerConfig  — nombre de empresa/finca y, por diseño, también
 *                                lat/lng/radio/umbral/horarios: el kiosco los
 *                                necesita para dar retroalimentación de
 *                                geocerca ANTES de marcar. La validación real
 *                                de geocerca, horario y biometría ocurre
 *                                siempre en el servidor dentro de `marcar` —
 *                                esta respuesta es solo para UX, nunca la
 *                                única barrera de seguridad.
 *   (sin accion, o accion desconocida) — health check, sin datos.
 *
 * Endpoints de dispositivo autorizado (requieren deviceToken emitido por
 * accion=autorizarDispositivo; un dispositivo revocado deja de poder usarlos):
 *   POST accion=marcar                    — registrar marcación (servidor valida todo)
 *   POST accion=marcasHoy                 — marcaciones del día por documento
 *   POST accion=sincronizarPersonalKiosco — catálogo ligero de personal
 *
 * Endpoints de sesión admin (requieren token de accion=login, expira en 15 min;
 * cada acción administrativa relevante queda registrada en la hoja de auditoría):
 *   POST accion=login                   — iniciar sesión admin (rate-limited)
 *   POST accion=loginSupervisor         — iniciar sesión supervisor (token 5 min, rate-limited)
 *   POST accion=cambiarPin              — cambiar PIN (sesión + PIN actual)
 *   POST accion=guardarConfig           — guardar configuración
 *   POST accion=registrarPersonal       — registrar empleado
 *   POST accion=guardarFotoPersonal     — guardar foto de enrolamiento
 *   POST accion=eliminarPersonal        — eliminar empleado
 *   POST accion=actualizarPersonal      — actualizar cargo/estado de empleado
 *   POST accion=activarPersonal         — reactivar empleado
 *   POST accion=inactivarPersonal       — inactivar empleado (conserva historial)
 *   POST accion=listarPersonal          — listar empleados (catálogo completo)
 *   POST accion=resumenDashboard        — resumen del día
 *   POST accion=borrarMarcacionesDelDia — borrar marcaciones de una persona en una fecha (admin)
 *   POST accion=autorizarSalidaAnticipada — autorizar salida anticipada ya registrada (admin)
 *   POST accion=autorizarHorasExtra     — autorizar horas extra ya registradas (admin)
 *   POST accion=autorizarDispositivo    — registrar y autorizar kiosco
 *   POST accion=listarDispositivos      — ver dispositivos autorizados
 *   POST accion=revocarDispositivo      — revocar acceso de un kiosco
 *
 * Endpoints de sesión admin O supervisor:
 *   POST accion=obtenerFoto             — foto privada de empleado (base64)
 ***********************************************************/

// El Sheet ID vive en PropertiesService (configúralo con setSheetId(), ver
// arriba) para no dejarlo hardcodeado en el código fuente del repositorio.
// El valor literal de abajo es solo un fallback de continuidad para esta
// instalación existente — cualquier instalación nueva debe llamar a
// setSheetId() con su propio Sheet antes de usarse en producción.
const SHEET_ID           = PropertiesService.getScriptProperties().getProperty('SHEET_ID')
                              || "1ZjIJ_AHty-ltlFDJP_0MV4mIXAhs1oNKhKcYWNMlbC8";
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

// Devuelve {ok, deviceId, nombre, empresa, finca, lat, lng, radio} o {ok:false, error}
// lat/lng/radio son la geocerca PROPIA de este dispositivo (fija desde que
// se autorizó), null si el dispositivo es de antes de que existiera este
// campo — en ese caso el llamador debe usar la configuración compartida.
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
    const [deviceId, dToken, nombre, empresa, finca, estado, , , lat, lng, radio] = datos[i];
    if (String(dToken).trim() === tok) {
      if (String(estado).trim().toLowerCase() !== 'activo') {
        CacheService.getScriptCache().put(cacheKey, JSON.stringify({ ok: false }), CACHE_DEVICE_TTL);
        return { ok: false, error: 'Dispositivo inactivo. Contacta al administrador.' };
      }
      const latN = parseFloat(lat), lngN = parseFloat(lng), radioN = parseInt(radio);
      const result = { ok: true, deviceId: String(deviceId).trim(), nombre: String(nombre).trim(),
                       empresa: String(empresa).trim(), finca: String(finca).trim(), row: i + 1,
                       lat: isNaN(latN) ? null : latN, lng: isNaN(lngN) ? null : lngN,
                       radio: isNaN(radioN) ? null : radioN };
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
   HELPERS: horarios por día de semana
══════════════════════════════════════════════════════ */

// Convierte "HH:MM" a decimal (6.5 = 6:30)
function _horaStrADecimal(horaStr) {
  const p = String(horaStr || '00:00').split(':').map(Number);
  return p[0] + (p[1] || 0) / 60;
}

// Convierte decimal a "HH:MM"
function _decimalAHoraStr(decimal) {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// Devuelve el objeto horario para un día de semana (0=Dom…6=Sáb) desde la config
// Retrocompatible con estructura antigua entrada/salida/salidaSab
function _getHorarioPorDia(diaSemana, cfg) {
  if (cfg.horarios && Array.isArray(cfg.horarios)) {
    const h = cfg.horarios.find(function(h) { return h.dia === diaSemana; });
    if (h) return h;
  }
  // Retrocompat: estructura antigua
  const esActivo = diaSemana >= 1 && diaSemana <= 6;
  if (!esActivo) return { dia: diaSemana, activo: false };
  const esSabado = diaSemana === 6;
  return {
    dia:        diaSemana,
    activo:     true,
    entrada:    _decimalAHoraStr(parseFloat(cfg.entrada || 6.0)),
    salida:     _decimalAHoraStr(esSabado ? parseFloat(cfg.salidaSab || 12.0) : parseFloat(cfg.salida || 15.0)),
    tolEntrada: 15,
    tolSalida:  0
  };
}

// Extrae el día de semana de una fecha "dd/MM/yyyy"
function _diaSemanaDeStr(fechaStr) {
  try {
    const p = String(fechaStr).split('/');
    return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0])).getDay();
  } catch (e) { return new Date().getDay(); }
}

/* ══════════════════════════════════════════════════════
   HELPERS: sanitización y hojas
══════════════════════════════════════════════════════ */

function sanitizarCelda(valor) {
  if (typeof valor !== 'string') return valor;
  return /^[=+\-@\t]/.test(valor) ? "'" + valor : valor;
}

// Lista oficial de las 30 columnas en el orden canónico del esquema v4
var COLUMNAS_MARCACIONES_V4 = [
  'MarcacionID','Fecha','HoraServidor','Documento','Nombre','Cargo','Finca','Tipo',
  'FechaLocal','FechaHoraCliente',
  'EstadoPuntualidad','MinutosDiferencia','MensajePuntualidad',
  'Latitud','Longitud','PrecisionGPS','EstadoGPS','DistanciaGeocerca','DentroGeocerca',
  'DistanciaFacial','SinBiometria',
  'SupervisorID','TipoExcepcion','MotivoSupervisor','FechaHoraAutorizacion',
  'DeviceID','AppVersion','SinConexion','FechaSincronizacion','ResultadoFacial',
  'ExtraAutorizada'
];

// Mapa de alias: cabecera antigua → nombre canónico en COLUMNAS_MARCACIONES_V4
var _ALIAS_COLUMNAS = {
  'Hora':          'HoraServidor',
  'Lat':           'Latitud',
  'Lng':           'Longitud',
  'Timestamp':     'FechaSincronizacion',
  'DeviceId':      'DeviceID',
  'ModoOffline':   'SinConexion',
};

/* Devuelve un mapa nombre→índice (0-based) leyendo la fila de cabeceras.
   Aplica alias del esquema antiguo para que el colMap siempre use nombres canónicos. */
function _getColMarcaciones(hoja) {
  const headers = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
  const m = {};
  headers.forEach(function(h, i) {
    const nombre = String(h).trim();
    const canonico = _ALIAS_COLUMNAS[nombre] || nombre;
    m[canonico] = i;
    // también guardar el nombre literal por si el llamador lo usa directamente
    if (canonico !== nombre) m[nombre] = i;
  });
  return m;
}

/* migrarEsquemaMarcaciones():
   - lee la cabecera existente (aplicando alias)
   - agrega al final cualquier columna canónica que falte
   - nunca borra ni mueve columnas ni datos existentes
   - devuelve un colMap actualizado */
function migrarEsquemaMarcaciones(hoja) {
  const colMap = _getColMarcaciones(hoja);
  const faltantes = COLUMNAS_MARCACIONES_V4.filter(function(c) { return colMap[c] == null; });
  if (faltantes.length === 0) return colMap;

  // Agregar columnas faltantes al final, una por una
  const ultimaCol = hoja.getLastColumn();
  faltantes.forEach(function(nombre, idx) {
    const col = ultimaCol + idx + 1;
    hoja.getRange(1, col).setValue(nombre);
    colMap[nombre] = col - 1; // 0-based
  });
  SpreadsheetApp.flush();
  return colMap;
}

function obtenerOhCrearHoja() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  let hoja   = ss.getSheetByName(HOJA_MARCACIONES);
  if (!hoja) {
    hoja = ss.insertSheet(HOJA_MARCACIONES);
    hoja.appendRow(COLUMNAS_MARCACIONES_V4);
    hoja.setFrozenRows(1);
  } else {
    // Migrar esquema si la hoja ya existe con cabeceras antiguas o parciales
    migrarEsquemaMarcaciones(hoja);
  }
  return hoja;
}

function obtenerOhCrearHojaPersonal() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  let hoja   = ss.getSheetByName(HOJA_PERSONAL);
  if (!hoja) {
    hoja = ss.insertSheet(HOJA_PERSONAL);
    hoja.appendRow(['Documento','Nombre','Cargo','Fecha registro','FotoId','Estado','JornadaContinua']);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function obtenerOhCrearHojaDispositivos() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  let hoja   = ss.getSheetByName(HOJA_DISPOSITIVOS);
  if (!hoja) {
    hoja = ss.insertSheet(HOJA_DISPOSITIVOS);
    hoja.appendRow(['DeviceId','DeviceToken','Nombre','Empresa','Finca','Estado','FechaRegistro','UltimaConexion','Lat','Lng','Radio']);
    hoja.setFrozenRows(1);
  } else {
    // Migrar: agregar columnas de geocerca propia por dispositivo si faltan
    // (hojas creadas antes de que existiera esta función). Nunca borra ni
    // mueve columnas existentes, solo agrega al final.
    const headers = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0].map(String);
    ['Lat', 'Lng', 'Radio'].forEach(function(col) {
      if (headers.indexOf(col) === -1) {
        hoja.getRange(1, hoja.getLastColumn() + 1).setValue(col);
        headers.push(col);
      }
    });
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
                  sanitizarCelda(cargo || ''), new Date(), fotoId, 'ACTIVO']);
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
// Cachea el catálogo completo de Personal (documento → nombre/cargo/estado)
// por 5 min, igual que PERSONAL_KIOSCO — se invalida en los mismos puntos
// donde cambia el personal (alta, edición, activar/inactivar, eliminar).
// Antes esta función leía toda la hoja Personal en cada marcación.
function _obtenerCatalogoPersonal() {
  const cacheKey = 'PERSONAL_LOOKUP';
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) return JSON.parse(cached);
  const hoja  = obtenerOhCrearHojaPersonal();
  const datos = hoja.getDataRange().getValues();
  const catalogo = {};
  for (let i = 1; i < datos.length; i++) {
    const doc = String(datos[i][0] || '').trim();
    if (!doc) continue;
    catalogo[doc] = {
      nombre: String(datos[i][1] || '').trim(),
      cargo:  String(datos[i][2] || '').trim(),
      estado: String(datos[i][5] || 'ACTIVO').trim().toUpperCase()
    };
  }
  try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(catalogo), 300); } catch (e) {}
  return catalogo;
}

function _buscarEmpleado(documento) {
  const doc = String(documento || '').trim();
  if (!doc) return { ok: false, error: 'Documento requerido' };
  const p = _obtenerCatalogoPersonal()[doc];
  if (!p) return { ok: false, error: 'Empleado no registrado' };
  if (p.estado === 'INACTIVO') return { ok: false, error: 'Empleado inactivo. Contacta al administrador.' };
  return { ok: true, nombre: p.nombre, cargo: p.cargo };
}

// Convierte "YYYY-MM-DD" (formato de <input type="date">) a "dd/MM/yyyy". Devuelve null si no aplica.
function _isoADdMmYyyy(valor) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor || ''));
  if (!m) return null;
  return m[3] + '/' + m[2] + '/' + m[1];
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
// datosPrecargados/colMapPrecargado: opcionales — si quien llama ya leyó la
// hoja en la misma solicitud (ej. accion=marcar), se reutilizan en vez de
// volver a leer toda la hoja de Marcaciones otra vez.
function _obtenerMarcasDelDia(documento, fechaStr, datosPrecargados, colMapPrecargado) {
  const doc  = String(documento || '').trim();
  let datos, colMap;
  if (datosPrecargados && colMapPrecargado) {
    datos = datosPrecargados;
    colMap = colMapPrecargado;
  } else {
    const hoja = obtenerOhCrearHoja();
    datos = hoja.getDataRange().getValues();
    colMap = _getColMarcaciones(hoja);
  }
  const iDoc  = colMap['Documento']  != null ? colMap['Documento']  : 3;
  const iFech = colMap['Fecha']      != null ? colMap['Fecha']      : 1;
  const iTipo = colMap['Tipo']       != null ? colMap['Tipo']       : 7;
  const marcas = [];
  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    if (normalizarFecha(fila[iFech]) === fechaStr && String(fila[iDoc]).trim() === doc)
      marcas.push(String(fila[iTipo]).trim());
  }
  return marcas;
}

// Busca una fila por MarcacionID dentro de `datos` ya leídos (evita releer
// toda la hoja si quien llama ya la tiene en memoria). Devuelve
// { encontrado, fila, rowIndex } o { encontrado: false }
function _buscarPorMarcacionId(datos, marcacionId, colMap) {
  if (!marcacionId) return { encontrado: false };
  const iMid = colMap['MarcacionID'] != null ? colMap['MarcacionID'] : 0;
  for (let i = 1; i < datos.length; i++) {
    if (String(datos[i][iMid]).trim() === String(marcacionId).trim()) {
      return { encontrado: true, fila: datos[i], rowIndex: i + 1 };
    }
  }
  return { encontrado: false };
}

// Calcula puntualidad oficial en el servidor — SIEMPRE en America/Bogota,
// independiente de la zona horaria configurada en el proyecto de Apps Script.
// Devuelve { estado, mensajePuntualidad, minutosDiferencia }
// tipoExcepcion: si es 'SALIDA_ANTICIPADA_AUTORIZADA' (ya validada contra
// sesión de supervisor por el llamador), la salida anticipada no cuenta
// como deuda de tiempo — quedó autorizada (ej. jornada continua).
function _calcularPuntualidadServidor(tipo, ahoraServidor, horarioDia, tipoExcepcion) {
  if (!horarioDia || !horarioDia.activo) {
    return { estado: 'sin_horario', mensajePuntualidad: 'Sin horario configurado', minutosDiferencia: 0 };
  }
  // Obtener hora explícitamente en America/Bogota — no confiar en getHours()/getMinutes()
  const horaEnBogota = Utilities.formatDate(ahoraServidor, 'America/Bogota', 'HH:mm');
  const horaDecimal  = _horaStrADecimal(horaEnBogota);

  if (tipo === 'Entrada') {
    const limiteEntrada = _horaStrADecimal(horarioDia.entrada || '06:00') + (horarioDia.tolEntrada || 0) / 60;
    const diffMin = Math.round((horaDecimal - limiteEntrada) * 60);
    if (diffMin > 0) return { estado: 'tarde',   mensajePuntualidad: 'Entrada tarde ' + diffMin + ' min', minutosDiferencia: diffMin };
    return             { estado: 'puntual', mensajePuntualidad: 'Entrada a tiempo', minutosDiferencia: 0 };
  } else {
    const limiteSalida = _horaStrADecimal(horarioDia.salida || '15:00') - (horarioDia.tolSalida || 0) / 60;
    const diffMin = Math.round((limiteSalida - horaDecimal) * 60);
    if (diffMin > 0) {
      if (tipoExcepcion === 'SALIDA_ANTICIPADA_AUTORIZADA') {
        return { estado: 'autorizada', mensajePuntualidad: 'Salida anticipada autorizada por supervisor (' + diffMin + ' min)', minutosDiferencia: 0 };
      }
      return { estado: 'temprano', mensajePuntualidad: 'Salida anticipada ' + diffMin + ' min', minutosDiferencia: diffMin };
    }
    return { estado: 'puntual', mensajePuntualidad: 'Salida a tiempo', minutosDiferencia: 0 };
  }
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

// Calcula si las coordenadas están dentro de la geocerca configurada.
// geocercaDispositivo: {lat,lng,radio} propia del kiosco que marca (prioridad)
// — si no viene, se usa la configuración compartida en PropertiesService
// (dispositivos autorizados antes de que existiera la geocerca por kiosco).
function _calcularGeocerca(lat, lng, geocercaDispositivo) {
  try {
    let cLat, cLng, radio;
    if (geocercaDispositivo && geocercaDispositivo.lat != null && geocercaDispositivo.lng != null) {
      cLat  = geocercaDispositivo.lat;
      cLng  = geocercaDispositivo.lng;
      radio = geocercaDispositivo.radio || 200;
    } else {
      const props = PropertiesService.getScriptProperties();
      const raw   = props.getProperty('APP_CONFIG');
      if (!raw) return { dentroGeocerca: false, distancia: null, sinConfig: true };
      const cfg = JSON.parse(raw);
      cLat  = parseFloat(cfg.lat);
      cLng  = parseFloat(cfg.lng);
      radio = parseInt(cfg.radio) || 200;
    }
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
      _auditarIntento('admin', 'CAMBIAR-PIN', 'admin');
      return _respuestaJson({ ok: true });
    }

    /* ── Guardar configuración (requiere sesión admin) ── */
    if (accion === 'guardarConfig') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const cfg = datos.config || {};
      // Campos generales de la empresa: SIEMPRE compartidos entre kioscos.
      const permitidosGenerales = ['empresa','fincaId','entrada','salida','salidaSab','umbral','horarios'];
      const seguro = {};
      permitidosGenerales.forEach(function(k) { if (cfg[k] != null) seguro[k] = cfg[k]; });

      // finca/lat/lng/radio: si este kiosco YA está autorizado (trae
      // deviceToken válido), se guardan en la fila propia de ESE
      // dispositivo — así editar la finca desde un kiosco no cambia lo que
      // ven los demás. Si el kiosco todavía no está autorizado, se guardan
      // en la config compartida como "borrador" hasta que se toque
      // "Autorizar este dispositivo" (que copia esos valores a su fila).
      const dv = datos.deviceToken ? _validarDeviceToken(datos.deviceToken) : { ok: false };
      const tieneGeoNueva = cfg.fincaNombre != null || cfg.lat != null || cfg.lng != null || cfg.radio != null;
      if (dv.ok && tieneGeoNueva) {
        const hoja  = obtenerOhCrearHojaDispositivos();
        const filas = hoja.getDataRange().getValues();
        for (let i = 1; i < filas.length; i++) {
          if (String(filas[i][0]).trim() === dv.deviceId) {
            if (cfg.fincaNombre != null) hoja.getRange(i + 1, 5).setValue(String(cfg.fincaNombre));
            if (cfg.lat != null)         hoja.getRange(i + 1, 9).setValue(parseFloat(cfg.lat));
            if (cfg.lng != null)         hoja.getRange(i + 1, 10).setValue(parseFloat(cfg.lng));
            if (cfg.radio != null)       hoja.getRange(i + 1, 11).setValue(parseInt(cfg.radio));
            SpreadsheetApp.flush();
            CacheService.getScriptCache().remove('DEV_' + String(datos.deviceToken).slice(0, 64));
            break;
          }
        }
      } else if (tieneGeoNueva) {
        if (cfg.fincaNombre != null) seguro.fincaNombre = cfg.fincaNombre;
        if (cfg.lat != null)         seguro.lat = cfg.lat;
        if (cfg.lng != null)         seguro.lng = cfg.lng;
        if (cfg.radio != null)       seguro.radio = cfg.radio;
      }

      PropertiesService.getScriptProperties().setProperty('APP_CONFIG', JSON.stringify(seguro));
      _auditarIntento('admin', 'GUARDAR-CONFIG', 'admin');
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
                               sanitizarCelda(datos.cargo), new Date(), '', 'ACTIVO',
                               datos.jornadaContinua ? 'SI' : '']);
      SpreadsheetApp.flush();
      // Invalidar cache de personal kiosco
      CacheService.getScriptCache().remove('PERSONAL_KIOSCO');
      CacheService.getScriptCache().remove('PERSONAL_LOOKUP');
      _auditarIntento(docNuevo, 'REGISTRAR-PERSONAL', 'admin');
      return _respuestaJson({ ok: true });
    }

    /* ── Guardar foto de enrolamiento (requiere sesión admin) ── */
    if (accion === 'guardarFotoPersonal') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      guardarFotoPersonal_(datos.documento, datos.foto, datos.nombre, datos.cargo);
      _auditarIntento(String(datos.documento || ''), 'GUARDAR-FOTO-PERSONAL', 'admin');
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
          CacheService.getScriptCache().remove('PERSONAL_LOOKUP');
          _auditarIntento(doc, 'ELIMINAR-PERSONAL', 'admin');
          return _respuestaJson({ ok: true });
        }
      }
      return _respuestaJson({ ok: false, error: 'Empleado no encontrado' });
    }

    /* ── Activar personal (requiere sesión admin) ── */
    if (accion === 'activarPersonal') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const hoja  = obtenerOhCrearHojaPersonal();
      const filas = hoja.getDataRange().getValues();
      const doc   = String(datos.documento || '').trim();
      for (let i = 1; i < filas.length; i++) {
        if (String(filas[i][0]).trim() === doc) {
          hoja.getRange(i + 1, 6).setValue('ACTIVO');
          SpreadsheetApp.flush();
          CacheService.getScriptCache().remove('PERSONAL_KIOSCO');
          CacheService.getScriptCache().remove('PERSONAL_LOOKUP');
          _auditarIntento(doc, 'ACTIVAR-PERSONAL', 'admin');
          return _respuestaJson({ ok: true });
        }
      }
      return _respuestaJson({ ok: false, error: 'Empleado no encontrado' });
    }

    /* ── Inactivar personal (requiere sesión admin, conserva historial) ── */
    if (accion === 'inactivarPersonal') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const hoja  = obtenerOhCrearHojaPersonal();
      const filas = hoja.getDataRange().getValues();
      const doc   = String(datos.documento || '').trim();
      for (let i = 1; i < filas.length; i++) {
        if (String(filas[i][0]).trim() === doc) {
          hoja.getRange(i + 1, 6).setValue('INACTIVO');
          SpreadsheetApp.flush();
          CacheService.getScriptCache().remove('PERSONAL_KIOSCO');
          CacheService.getScriptCache().remove('PERSONAL_LOOKUP');
          _auditarIntento(doc, 'INACTIVAR-PERSONAL', 'admin');
          return _respuestaJson({ ok: true });
        }
      }
      return _respuestaJson({ ok: false, error: 'Empleado no encontrado' });
    }

    /* ── Actualizar cargo/estado de personal (requiere sesión admin) ── */
    if (accion === 'actualizarPersonal') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const hoja  = obtenerOhCrearHojaPersonal();
      const filas = hoja.getDataRange().getValues();
      const doc   = String(datos.documento || '').trim();
      if (!doc) return _respuestaJson({ ok: false, error: 'documento requerido' });
      for (let i = 1; i < filas.length; i++) {
        if (String(filas[i][0]).trim() === doc) {
          if (datos.cargo) hoja.getRange(i + 1, 3).setValue(datos.cargo);
          if (typeof datos.activo === 'boolean') hoja.getRange(i + 1, 6).setValue(datos.activo ? 'ACTIVO' : 'INACTIVO');
          if (typeof datos.jornadaContinua === 'boolean') hoja.getRange(i + 1, 7).setValue(datos.jornadaContinua ? 'SI' : '');
          SpreadsheetApp.flush();
          CacheService.getScriptCache().remove('PERSONAL_KIOSCO');
          CacheService.getScriptCache().remove('PERSONAL_LOOKUP');
          _auditarIntento(doc, 'ACTUALIZAR-PERSONAL', 'admin');
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
        const [doc, nombre, cargo, , , estado, jornadaContinua] = filas[i];
        if (doc && nombre) personal.push({
          documento: String(doc).trim(), nombre: String(nombre).trim(),
          cargo: String(cargo || '').trim(), estado: String(estado || 'ACTIVO').trim(),
          jornadaContinua: String(jornadaContinua || '').trim().toUpperCase() === 'SI'
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

    /* ── Borrar marcaciones del día de una persona (requiere sesión admin) ── */
    if (accion === 'borrarMarcacionesDelDia') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const documento = String(datos.documento || '').trim();
      if (!documento) return _respuestaJson({ ok: false, error: 'documento requerido' });
      const fecha = _isoADdMmYyyy(datos.fecha) || String(datos.fecha || '').trim();
      if (!fecha) return _respuestaJson({ ok: false, error: 'fecha requerida' });

      const hoja   = obtenerOhCrearHoja();
      const datosH = hoja.getDataRange().getValues();
      const colMap = _getColMarcaciones(hoja);
      const iDoc   = colMap['Documento'] != null ? colMap['Documento'] : 3;
      const iFech  = colMap['Fecha']     != null ? colMap['Fecha']     : 1;

      let borradas = 0;
      for (let i = datosH.length - 1; i >= 1; i--) {
        const fila = datosH[i];
        if (normalizarFecha(fila[iFech]) === fecha && String(fila[iDoc]).trim() === documento) {
          hoja.deleteRow(i + 1);
          borradas++;
        }
      }
      if (borradas > 0) SpreadsheetApp.flush();
      _auditarIntento(documento, 'BORRAR-MARCACIONES-DIA', 'admin:' + fecha + ':' + borradas + ' fila(s)');
      return _respuestaJson({ ok: true, borradas: borradas });
    }

    /* ── Autorizar salida anticipada de un día ya registrado (requiere sesión
       admin) — corrección posterior, no interrumpe al trabajador en el kiosco. ── */
    if (accion === 'autorizarSalidaAnticipada') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const documento = String(datos.documento || '').trim();
      if (!documento) return _respuestaJson({ ok: false, error: 'documento requerido' });
      const fecha = _isoADdMmYyyy(datos.fecha) || String(datos.fecha || '').trim();
      if (!fecha) return _respuestaJson({ ok: false, error: 'fecha requerida' });

      const hoja   = obtenerOhCrearHoja();
      const datosH = hoja.getDataRange().getValues();
      const colMap = _getColMarcaciones(hoja);
      const iDoc   = colMap['Documento'] != null ? colMap['Documento'] : 3;
      const iFech  = colMap['Fecha']     != null ? colMap['Fecha']     : 1;
      const iTipo  = colMap['Tipo']      != null ? colMap['Tipo']      : 7;

      for (let i = 1; i < datosH.length; i++) {
        const fila = datosH[i];
        if (normalizarFecha(fila[iFech]) === fecha && String(fila[iDoc]).trim() === documento && fila[iTipo] === 'Salida') {
          if (colMap['TipoExcepcion'] != null)     hoja.getRange(i + 1, colMap['TipoExcepcion'] + 1).setValue('SALIDA_ANTICIPADA_AUTORIZADA');
          if (colMap['EstadoPuntualidad'] != null) hoja.getRange(i + 1, colMap['EstadoPuntualidad'] + 1).setValue('autorizada');
          if (colMap['MinutosDiferencia'] != null) hoja.getRange(i + 1, colMap['MinutosDiferencia'] + 1).setValue(0);
          if (colMap['MensajePuntualidad'] != null)hoja.getRange(i + 1, colMap['MensajePuntualidad'] + 1).setValue('Salida anticipada autorizada por administrador');
          if (colMap['MotivoSupervisor'] != null)  hoja.getRange(i + 1, colMap['MotivoSupervisor'] + 1).setValue('Autorizado desde Reporte de asistencia');
          SpreadsheetApp.flush();
          _auditarIntento(documento, 'AUTORIZAR-SALIDA-ANTICIPADA', 'admin:' + fecha);
          return _respuestaJson({ ok: true });
        }
      }
      return _respuestaJson({ ok: false, error: 'No se encontró una Salida registrada ese día para esta persona' });
    }

    /* ── Autorizar horas extra ya registradas (requiere sesión admin) ── */
    if (accion === 'autorizarHorasExtra') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const documento = String(datos.documento || '').trim();
      if (!documento) return _respuestaJson({ ok: false, error: 'documento requerido' });
      const fecha = _isoADdMmYyyy(datos.fecha) || String(datos.fecha || '').trim();
      if (!fecha) return _respuestaJson({ ok: false, error: 'fecha requerida' });

      const hoja   = obtenerOhCrearHoja();
      const datosH = hoja.getDataRange().getValues();
      const colMap = _getColMarcaciones(hoja);
      const iDoc   = colMap['Documento'] != null ? colMap['Documento'] : 3;
      const iFech  = colMap['Fecha']     != null ? colMap['Fecha']     : 1;
      const iTipo  = colMap['Tipo']      != null ? colMap['Tipo']      : 7;

      for (let i = 1; i < datosH.length; i++) {
        const fila = datosH[i];
        if (normalizarFecha(fila[iFech]) === fecha && String(fila[iDoc]).trim() === documento && fila[iTipo] === 'Salida') {
          if (colMap['ExtraAutorizada'] != null)   hoja.getRange(i + 1, colMap['ExtraAutorizada'] + 1).setValue('SI');
          if (colMap['MotivoSupervisor'] != null)  hoja.getRange(i + 1, colMap['MotivoSupervisor'] + 1).setValue('Horas extra autorizadas desde Reporte');
          SpreadsheetApp.flush();
          _auditarIntento(documento, 'AUTORIZAR-HORAS-EXTRA', 'admin:' + fecha);
          return _respuestaJson({ ok: true });
        }
      }
      return _respuestaJson({ ok: false, error: 'No se encontró una Salida registrada ese día para esta persona' });
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
      const lat     = cfg.lat != null ? parseFloat(cfg.lat) : '';
      const lng     = cfg.lng != null ? parseFloat(cfg.lng) : '';
      const radio   = cfg.radio != null ? parseInt(cfg.radio) : '';
      const nombre  = String(datos.nombre || 'Kiosco').trim().slice(0, 60);
      // Verificar si ya existe
      const hoja  = obtenerOhCrearHojaDispositivos();
      const filas = hoja.getDataRange().getValues();
      for (let i = 1; i < filas.length; i++) {
        if (String(filas[i][0]).trim() === deviceId) {
          // Ya existe: solo reactivar si estaba inactivo. NO tocar su
          // finca/lat/lng/radio — eso ahora se edita únicamente desde
          // "Guardar configuración" (escribe directo en la fila de ESTE
          // dispositivo). Si "Autorizar" también copiara aquí la config
          // compartida, cada vez que se reautoriza un kiosco ya editado se
          // le borraría su finca propia y volvería a la de otro kiosco.
          // Excepción: si el dispositivo es de antes de que existiera la
          // geocerca por kiosco (celdas vacías), se siembra con la
          // compartida como punto de partida.
          if (String(filas[i][5]).trim().toLowerCase() !== 'activo') {
            hoja.getRange(i + 1, 6).setValue('activo');
          }
          const yaTieneGeo = filas[i][8] !== '' && filas[i][8] != null;
          if (!yaTieneGeo) {
            hoja.getRange(i + 1, 5).setValue(finca);
            hoja.getRange(i + 1, 9).setValue(lat);
            hoja.getRange(i + 1, 10).setValue(lng);
            hoja.getRange(i + 1, 11).setValue(radio);
          }
          SpreadsheetApp.flush();
          const existingToken = String(filas[i][1]).trim();
          CacheService.getScriptCache().remove('DEV_' + existingToken);
          _auditarIntento(deviceId, 'AUTORIZAR-DISPOSITIVO', 'admin');
          return _respuestaJson({ ok: true, deviceToken: existingToken, nuevo: false });
        }
      }
      const deviceToken = _generarDeviceToken();
      hoja.appendRow([deviceId, deviceToken, nombre, empresa, finca, 'activo', new Date(), new Date(), lat, lng, radio]);
      SpreadsheetApp.flush();
      _auditarIntento(deviceId, 'AUTORIZAR-DISPOSITIVO', 'admin');
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
          _auditarIntento(deviceId, 'REVOCAR-DISPOSITIVO', 'admin');
          return _respuestaJson({ ok: true });
        }
      }
      return _respuestaJson({ ok: false, error: 'Dispositivo no encontrado' });
    }

    /* ── Sincronizar personal (requiere deviceToken de kiosco autorizado) ── */
    if (accion === 'sincronizarPersonalKiosco') {
      const dv = _validarDeviceToken(datos.deviceToken);
      if (!dv.ok) return _respuestaJson({ ok: false, error: dv.error });
      if (!datos.deviceId) return _respuestaJson({ ok: false, error: 'deviceId requerido.' });
      if (String(datos.deviceId).trim().slice(0, 64) !== dv.deviceId)
        return _respuestaJson({ ok: false, error: 'Dispositivo no autorizado.' });
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
          const [doc, nombre, cargo, , , estado] = filas[i];
          const estadoStr = String(estado || 'ACTIVO').trim().toUpperCase();
          if (doc && nombre && estadoStr !== 'INACTIVO') personal.push({
            documento: String(doc).trim(), nombre: String(nombre).trim(),
            cargo: String(cargo || '').trim()
          });
        }
        try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(personal), 300); } catch (e) {}
      }
      return _respuestaJson({ ok: true, personal: personal, version: new Date().getTime() });
    }

    /* ── Marcas del día (requiere deviceToken de kiosco autorizado) ── */
    /* ── Geocerca/finca propia de ESTE kiosco (no la compartida) ── */
    // El cliente la necesita para decidir localmente si está dentro del
    // cerco antes de marcar — si usara la configuración compartida en su
    // lugar, cambiar la finca en Configuración para dar de alta un kiosco
    // nuevo haría que los kioscos YA autorizados muestren "fuera de la
    // geocerca" (o la oculten) usando la ubicación de otro kiosco.
    if (accion === 'infoDispositivo') {
      const dv = _validarDeviceToken(datos.deviceToken);
      if (!dv.ok) return _respuestaJson({ ok: false, error: dv.error });
      if (!datos.deviceId) return _respuestaJson({ ok: false, error: 'deviceId requerido.' });
      if (String(datos.deviceId).trim().slice(0, 64) !== dv.deviceId)
        return _respuestaJson({ ok: false, error: 'Dispositivo no autorizado.' });
      return _respuestaJson({
        ok: true, finca: dv.finca || '',
        lat: dv.lat, lng: dv.lng, radio: dv.radio
      });
    }

    if (accion === 'marcasHoy') {
      const dv = _validarDeviceToken(datos.deviceToken);
      if (!dv.ok) return _respuestaJson({ ok: false, error: dv.error });
      if (!datos.deviceId) return _respuestaJson({ ok: false, error: 'deviceId requerido.' });
      if (String(datos.deviceId).trim().slice(0, 64) !== dv.deviceId)
        return _respuestaJson({ ok: false, error: 'Dispositivo no autorizado.' });
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

      if (!datos.deviceId) return _respuestaJson({ ok: false, error: 'deviceId requerido.' });
      if (String(datos.deviceId).trim().slice(0, 64) !== dv.deviceId)
        return _respuestaJson({ ok: false, error: 'Dispositivo no autorizado.' });

      const tipo = String(datos.tipo || '').trim();
      if (tipo !== 'Entrada' && tipo !== 'Salida')
        return _respuestaJson({ ok: false, error: 'Tipo inválido. Solo se acepta Entrada o Salida.' });

      const documento = String(datos.documento || '').trim();
      if (!documento) return _respuestaJson({ ok: false, error: 'documento requerido' });
      const empleado  = _buscarEmpleado(documento);
      if (!empleado.ok) return _respuestaJson({ ok: false, error: empleado.error });

      const marcacionId = String(datos.marcacionId || '').trim();
      if (!marcacionId) return _respuestaJson({ ok: false, error: 'marcacionId requerido' });

      // ── LockService: serializar solicitudes simultáneas ──
      const lock = LockService.getScriptLock();
      try { lock.waitLock(10000); } catch (e) {
        return _respuestaJson({ ok: false, error: 'El servidor está procesando otra solicitud. Intente nuevamente.' });
      }

      try {
        const hoja   = obtenerOhCrearHoja();
        const colMap = _getColMarcaciones(hoja);
        // Una sola lectura completa de la hoja para esta solicitud — se
        // reutiliza tanto para la verificación de idempotencia como para
        // buscar las marcas del día, en vez de leer la hoja dos veces más.
        const datosHoja = hoja.getDataRange().getValues();

        // ── IDEMPOTENCIA: si ya existe este marcacionId, devolver la fila original ──
        if (marcacionId) {
          const existente = _buscarPorMarcacionId(datosHoja, marcacionId, colMap);
          if (existente.encontrado) {
            const f = existente.fila;
            const iHora   = colMap['HoraServidor']      != null ? colMap['HoraServidor']      : 2;
            const iNombre = colMap['Nombre']             != null ? colMap['Nombre']             : 4;
            const iCargo  = colMap['Cargo']              != null ? colMap['Cargo']              : 5;
            const iFinca  = colMap['Finca']              != null ? colMap['Finca']              : 6;
            const iDentro = colMap['DentroGeocerca']     != null ? colMap['DentroGeocerca']     : 18;
            const iDist   = colMap['DistanciaGeocerca']  != null ? colMap['DistanciaGeocerca']  : 17;
            const iEst    = colMap['EstadoPuntualidad']  != null ? colMap['EstadoPuntualidad']  : 10;
            const iMsg    = colMap['MensajePuntualidad'] != null ? colMap['MensajePuntualidad'] : 12;
            const iMin    = colMap['MinutosDiferencia']  != null ? colMap['MinutosDiferencia']  : 11;
            _auditarIntento(documento, 'MARCAR-IDEMPOTENTE', marcacionId);
            return _respuestaJson({
              ok: true, idempotente: true,
              nombre: String(f[iNombre] || ''), cargo: String(f[iCargo] || ''), finca: String(f[iFinca] || ''),
              dentroGeocerca: String(f[iDentro]) === 'SI',
              distanciaMetros: f[iDist] !== '' ? Number(f[iDist]) : null,
              horaServidor: String(f[iHora] || ''),
              estadoPuntualidad:  String(f[iEst]  || ''),
              mensajePuntualidad: String(f[iMsg]  || ''),
              minutosDiferencia:  Number(f[iMin]  || 0),
            });
          }
        }

        // Fecha y hora: normalmente la del SERVIDOR (nunca la del cliente, para
        // evitar que se pueda falsear la hora de una marcación normal). La
        // EXCEPCIÓN es una marcación que se hizo SIN CONEXIÓN y se está
        // sincronizando ahora: ahí sí se usa la fecha/hora que el cliente
        // reportó al momento real de marcar — si no, un kiosco que estuvo
        // horas (o un día) sin internet sincroniza TODO con la fecha/hora en
        // que por fin volvió la señal, lo cual no solo registra mal la hora
        // sino que además puede hacer que dos marcaciones de días distintos
        // (ej. Salida de ayer y Entrada de hoy) queden ambas fechadas "hoy",
        // y la validación de secuencia rechace la segunda como duplicado
        // (se pierde la marcación).
        let ahoraServidor = new Date();
        if (datos.sinConexion === true && datos.fechaHora) {
          const fechaCliente = new Date(datos.fechaHora);
          const ahora = new Date();
          const TREINTA_DIAS_MS = 30 * 24 * 60 * 60 * 1000;
          if (!isNaN(fechaCliente.getTime()) && fechaCliente <= ahora && (ahora - fechaCliente) <= TREINTA_DIAS_MS) {
            ahoraServidor = fechaCliente;
          }
        }
        const hoyStr  = Utilities.formatDate(ahoraServidor, 'America/Bogota', 'dd/MM/yyyy');
        const horaStr = Utilities.formatDate(ahoraServidor, 'America/Bogota', 'HH:mm:ss');

        const marcasDelDia = _obtenerMarcasDelDia(documento, hoyStr, datosHoja, colMap);
        const seqVal = _validarSecuencia(marcasDelDia, tipo);
        if (!seqVal.ok) {
          // Auditar: sin esto no queda ningún rastro en el servidor de una
          // marcación (sobre todo sin conexión) que el cliente creyó exitosa
          // pero el servidor rechazó — imposible diagnosticar después.
          _auditarIntento(documento, 'MARCAR-RECHAZO-SECUENCIA', tipo + '|' + hoyStr + '|' + seqVal.error);
          return _respuestaJson({ ok: false, error: seqVal.error });
        }

        // Configuración del servidor
        const appCfg = (function() {
          try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('APP_CONFIG') || '{}'); }
          catch (e) { return {}; }
        })();

        // GPS
        const lat = parseFloat(datos.lat);
        const lng = parseFloat(datos.lng);
        const gpsValido = !isNaN(lat) && !isNaN(lng);
        // La geocerca es la propia del dispositivo/kiosco (fija desde que se
        // autorizó); si el dispositivo es de antes de que existiera este
        // campo, se usa la configuración compartida como respaldo.
        const geocercaDispositivo = (dv.lat != null && dv.lng != null)
          ? { lat: dv.lat, lng: dv.lng, radio: dv.radio }
          : null;
        const geocercaConfigurada = geocercaDispositivo
          ? true
          : (!isNaN(parseFloat(appCfg.lat)) && !isNaN(parseFloat(appCfg.lng)));
        let dentroGeocerca = false, distanciaMetros = null;
        let sinConfigGeo = !geocercaConfigurada;
        let gpsAusente = false;

        if (gpsValido && geocercaConfigurada) {
          const geo = _calcularGeocerca(lat, lng, geocercaDispositivo);
          dentroGeocerca  = geo.dentroGeocerca;
          distanciaMetros = geo.distancia;
          sinConfigGeo    = !!geo.sinConfig;
        } else if (!gpsValido && geocercaConfigurada) {
          gpsAusente   = true;
          sinConfigGeo = false;
        }

        let estadoGPS = gpsValido ? 'SIN_PRECISION' : 'AUSENTE';
        if (gpsValido) {
          const precRaw = datos.precisionGPS;
          if (precRaw == null || precRaw === '') {
            if (geocercaConfigurada) {
              const svPrec = _validarSesion(datos.supervisorToken, ['supervisor']);
              if (!svPrec.ok) {
                return _respuestaJson({
                  ok: false,
                  error: 'Precisión GPS no informada. Con geocerca configurada se requiere autorización de supervisor cuando no se conoce la exactitud de la ubicación.'
                });
              }
            }
          } else {
            const prec = parseFloat(precRaw);
            if (isNaN(prec) || prec < 0 || prec > 50000)
              return _respuestaJson({ ok: false, error: 'Valor de precisión GPS inválido.' });
            if (prec <= 50)       estadoGPS = 'PRECISO';
            else if (prec <= 100) estadoGPS = 'MEDIO';
            else {
              estadoGPS = 'BAJO';
              const svPrec = _validarSesion(datos.supervisorToken, ['supervisor']);
              if (!svPrec.ok) {
                return _respuestaJson({
                  ok: false,
                  error: 'Precisión GPS insuficiente (' + Math.round(prec) + ' m de incertidumbre). Mejora la señal GPS o solicita autorización de supervisor.'
                });
              }
            }
          }
        }

        const esFueraGeo = !dentroGeocerca && !sinConfigGeo;
        if (esFueraGeo) {
          const svGeo = _validarSesion(datos.supervisorToken, ['supervisor']);
          if (!svGeo.ok) {
            return _respuestaJson({
              ok: false, fueraGeocerca: true, gpsAusente: gpsAusente,
              distanciaMetros: distanciaMetros,
              error: gpsAusente
                ? 'GPS no disponible. Se requiere autorización de supervisor para registrar sin ubicación.'
                : 'Fuera de la geocerca. Se requiere autorización de supervisor para registrar.'
            });
          }
        }

        if (datos.sinBiometria === true) {
          const svBio = _validarSesion(datos.supervisorToken, ['supervisor']);
          if (!svBio.ok) {
            return _respuestaJson({
              ok: false,
              error: 'Marcación sin reconocimiento facial requiere autorización de supervisor. ' + svBio.error
            });
          }
        }

        // Salida anticipada autorizada (ej. jornada continua sin almuerzo):
        // exigir sesión de supervisor real — nunca confiar en que el cliente
        // marque la excepción sin haberla validado.
        if (datos.tipoExcepcion === 'SALIDA_ANTICIPADA_AUTORIZADA') {
          const svSalida = _validarSesion(datos.supervisorToken, ['supervisor']);
          if (!svSalida.ok) {
            return _respuestaJson({
              ok: false,
              error: 'Salida anticipada requiere autorización de supervisor. ' + svSalida.error
            });
          }
        }

        if (datos.sinBiometria !== true) {
          const dist = datos.distanciaFacial;
          if (dist == null || dist === '')
            return _respuestaJson({ ok: false, error: 'Se requiere reconocimiento facial para registrar.' });
          const distNum = parseFloat(dist);
          if (isNaN(distNum) || distNum < 0 || distNum > 1)
            return _respuestaJson({ ok: false, error: 'Valor de reconocimiento facial inválido.' });
          const umbral = parseFloat(appCfg.umbral);
          if (isNaN(umbral) || umbral <= 0 || umbral > 1)
            return _respuestaJson({ ok: false, error: 'Umbral facial no configurado en el servidor. Configura el parámetro umbral antes de registrar marcaciones biométricas.' });
          if (distNum > umbral)
            return _respuestaJson({
              ok: false,
              error: 'Reconocimiento facial no coincide con el registro (distancia: ' + distNum.toFixed(3) + ', umbral: ' + umbral + ').'
            });
        }

        const nombre = empleado.nombre;
        const cargo  = empleado.cargo;
        // La finca de cada marcación debe ser la del dispositivo/kiosco que
        // marca (fija desde que se autorizó ese kiosco), no la configuración
        // general compartida — si no, cambiar la finca en Configuración para
        // dar de alta un kiosco nuevo hace que TODOS los kioscos existentes
        // empiecen a marcar con esa misma finca.
        const finca  = dv.finca || appCfg.fincaNombre || '';

        let resultadoFacial;
        if      (datos.sinBiometria && esFueraGeo && gpsAusente) resultadoFacial = 'SUPERVISOR_BIO_GPS_GEO';
        else if (datos.sinBiometria && gpsAusente)               resultadoFacial = 'SUPERVISOR_BIO_GPS';
        else if (datos.sinBiometria && esFueraGeo)               resultadoFacial = 'SUPERVISOR_BIO_GEO';
        else if (datos.sinBiometria)                             resultadoFacial = 'SUPERVISOR_BIO';
        else if (gpsAusente)                                     resultadoFacial = 'SUPERVISOR_GPS';
        else if (esFueraGeo)                                     resultadoFacial = 'SUPERVISOR_GEO';
        else if (datos.distanciaFacial != null)                  resultadoFacial = 'FACIAL';
        else                                                     resultadoFacial = 'SIN_BIOMETRIA';

        // Puntualidad oficial (servidor, zona America/Bogota)
        const diaSemana   = _diaSemanaDeStr(hoyStr);
        const horarioDia  = _getHorarioPorDia(diaSemana, appCfg);
        const puntualidad = _calcularPuntualidadServidor(tipo, ahoraServidor, horarioDia, datos.tipoExcepcion);

        // ── Insertar fila usando colMap: correcto sin importar el orden físico de columnas ──
        // (una hoja migrada puede tener las columnas en otro orden que una hoja nueva)
        const fila = new Array(hoja.getLastColumn()).fill('');
        function _set(col, val) { if (colMap[col] != null) fila[colMap[col]] = val; }
        _set('MarcacionID',          marcacionId);
        _set('Fecha',                hoyStr);
        _set('HoraServidor',         horaStr);
        _set('Documento',            sanitizarCelda(documento));
        _set('Nombre',               sanitizarCelda(nombre));
        _set('Cargo',                sanitizarCelda(cargo));
        _set('Finca',                sanitizarCelda(finca));
        _set('Tipo',                 tipo);
        _set('FechaLocal',           sanitizarCelda(String(datos.fechaLocal || '')));
        _set('FechaHoraCliente',     sanitizarCelda(String(datos.fechaHora  || '')));
        _set('EstadoPuntualidad',    puntualidad.estado);
        _set('MinutosDiferencia',    puntualidad.minutosDiferencia);
        _set('MensajePuntualidad',   puntualidad.mensajePuntualidad);
        _set('Latitud',              gpsValido ? lat : '');
        _set('Longitud',             gpsValido ? lng : '');
        _set('PrecisionGPS',         datos.precisionGPS != null ? parseFloat(datos.precisionGPS).toFixed(1) : '');
        _set('EstadoGPS',            estadoGPS);
        _set('DistanciaGeocerca',    distanciaMetros != null ? distanciaMetros : '');
        _set('DentroGeocerca',       dentroGeocerca ? 'SI' : (gpsAusente ? 'GPS_AUSENTE' : 'NO'));
        _set('DistanciaFacial',      datos.distanciaFacial != null ? parseFloat(datos.distanciaFacial).toFixed(3) : '');
        _set('SinBiometria',         datos.sinBiometria ? 'SI' : 'NO');
        _set('SupervisorID',         sanitizarCelda(String(datos.supervisorId || '')));
        _set('TipoExcepcion',        sanitizarCelda(String(datos.tipoExcepcion || '')));
        _set('MotivoSupervisor',     sanitizarCelda(String(datos.motivoSupervisor || '')));
        _set('FechaHoraAutorizacion',sanitizarCelda(String(datos.fechaHoraAutorizacion || '')));
        _set('DeviceID',             sanitizarCelda(dv.deviceId));
        _set('AppVersion',           sanitizarCelda(String(datos.appVersion || '')));
        _set('SinConexion',          datos.sinConexion ? 'OFFLINE' : 'ONLINE');
        _set('FechaSincronizacion',  new Date().toISOString());
        _set('ResultadoFacial',      resultadoFacial);
        hoja.appendRow(fila);
        SpreadsheetApp.flush();
        _auditarIntento(documento, 'MARCAR-OK', tipo + '|' + hoyStr + ' ' + horaStr + '|' + finca + '|' + (datos.sinConexion ? 'OFFLINE' : 'ONLINE'));

        _actualizarUltimaConexion(datos.deviceToken);

        if (tipo === 'Salida') {
          try { calcularResumenDiario(); } catch (e) { Logger.log('calcularResumenDiario: ' + e.message); }
        }

        return _respuestaJson({
          ok: true, nombre: nombre, cargo: cargo, finca: finca,
          dentroGeocerca: dentroGeocerca, distanciaMetros: distanciaMetros,
          horaServidor: horaStr,
          estadoPuntualidad:  puntualidad.estado,
          mensajePuntualidad: puntualidad.mensajePuntualidad,
          minutosDiferencia:  puntualidad.minutosDiferencia,
        });

      } finally {
        lock.releaseLock();
      }
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
  // El selector de fecha del frontend (<input type="date">) envía formato ISO (YYYY-MM-DD);
  // la hoja y el resto del backend usan dd/MM/yyyy — convertir antes de comparar.
  const fecha = _isoADdMmYyyy(fechaParam) || fechaParam || hoy;
  const hoja  = obtenerOhCrearHoja();
  const datos = hoja.getDataRange().getValues();
  const cfg   = (function() {
    try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('APP_CONFIG') || '{}'); }
    catch (e) { return {}; }
  })();
  const diaSemana = _diaSemanaDeStr(fecha);
  const horarioDelDia = _getHorarioPorDia(diaSemana, cfg);
  const HORA_TOLERANCIA_ENTRADA = horarioDelDia.activo
    ? (_horaStrADecimal(horarioDelDia.entrada || '06:00') + (horarioDelDia.tolEntrada || 15) / 60)
    : 999;
  const porPersona = {};

  const colMap  = _getColMarcaciones(hoja);
  const iFecha  = colMap['Fecha']       != null ? colMap['Fecha']       : 1;
  const iHora   = colMap['HoraServidor']!= null ? colMap['HoraServidor']: 2;
  const iDoc    = colMap['Documento']   != null ? colMap['Documento']   : 3;
  const iNombre = colMap['Nombre']      != null ? colMap['Nombre']      : 4;
  const iCargo  = colMap['Cargo']       != null ? colMap['Cargo']       : 5;
  const iFinca  = colMap['Finca']       != null ? colMap['Finca']       : 6;
  const iTipo   = colMap['Tipo']        != null ? colMap['Tipo']        : 7;
  const iExcep  = colMap['TipoExcepcion'];
  const iExtraAut = colMap['ExtraAutorizada'];

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const fechaFila = fila[iFecha], hora = fila[iHora], nombre = fila[iNombre];
    const documento = fila[iDoc],   cargo = fila[iCargo], finca = fila[iFinca];
    const tipo      = fila[iTipo];
    if (normalizarFecha(fechaFila) !== fecha) continue;
    if (fincaFiltro && String(finca) !== String(fincaFiltro)) continue;
    const clave = String(documento);
    // Cada marcación guarda su propia finca (viene del kiosco/dispositivo,
    // no de la persona) — un trabajador puede entrar en una finca y salir
    // en otra, así que no se puede asumir una sola finca por persona/día.
    if (!porPersona[clave]) porPersona[clave] = { nombre: nombre, cargo: cargo };
    porPersona[clave][tipo] = normalizarHora(hora);
    if (tipo === 'Entrada') porPersona[clave].fincaEntrada = finca;
    if (tipo === 'Salida')  porPersona[clave].fincaSalida  = finca;
    if (tipo === 'Salida' && iExcep != null) porPersona[clave].excepcionSalida = String(fila[iExcep] || '');
    if (tipo === 'Salida' && iExtraAut != null) porPersona[clave].extraAutorizada = String(fila[iExtraAut] || '').trim().toUpperCase() === 'SI';
  }

  let tardanzas = 0, jornadasCompletas = 0, totalHoras = 0;
  const porFinca = {}, filas = [];

  const horaADecimal = function(hStr) {
    const partes = String(hStr).split(':').map(Number);
    return partes[0] + partes[1] / 60 + (partes[2] || 0) / 3600;
  };

  const HORA_TOLERANCIA_SALIDA = horarioDelDia.activo
    ? (_horaStrADecimal(horarioDelDia.salida || '15:00') - (horarioDelDia.tolSalida || 5) / 60)
    : -999;

  // Duración real de la jornada configurada para este día (no un valor fijo),
  // descontando el almuerzo — el tiempo entre entrada y salida no es todo
  // tiempo trabajado. Quienes tienen "jornada continua" no tienen ese
  // descuento porque no salen a almorzar.
  const HORAS_ALMUERZO_DEFECTO = (horarioDelDia.minutosAlmuerzo || 0) / 60;
  const jornadaContinuaPorDoc = {};
  (function() {
    const hojaPersonal = obtenerOhCrearHojaPersonal();
    const filasPersonal = hojaPersonal.getDataRange().getValues();
    for (let i = 1; i < filasPersonal.length; i++) {
      const doc = filasPersonal[i][0];
      const jc  = String(filasPersonal[i][6] || '').trim().toUpperCase() === 'SI';
      if (doc) jornadaContinuaPorDoc[String(doc).trim()] = jc;
    }
  })();
  const duracionJornada = horarioDelDia.activo
    ? (_horaStrADecimal(horarioDelDia.salida || '15:00') - _horaStrADecimal(horarioDelDia.entrada || '06:00'))
    : null;

  Object.keys(porPersona).forEach(function(documento) {
    const p = porPersona[documento];
    const fincaPrincipal = p.fincaEntrada || p.fincaSalida || '';
    porFinca[fincaPrincipal] = (porFinca[fincaPrincipal] || 0) + 1;
    const marcas = [];
    const puntualidad = [];
    let minutosDeuda = 0;
    if (p.Entrada) {
      marcas.push('Entrada');
      const hEntrada = horaADecimal(p.Entrada);
      if (hEntrada > HORA_TOLERANCIA_ENTRADA) {
        tardanzas++;
        const minutos = Math.round((hEntrada - HORA_TOLERANCIA_ENTRADA) * 60);
        minutosDeuda += minutos;
        puntualidad.push({ tipo: 'Entrada', estado: 'tarde', minutos: minutos });
      }
    }
    if (p.Salida) {
      marcas.push('Salida');
      const hSalida = horaADecimal(p.Salida);
      if (hSalida < HORA_TOLERANCIA_SALIDA) {
        if (p.excepcionSalida === 'SALIDA_ANTICIPADA_AUTORIZADA') {
          puntualidad.push({ tipo: 'Salida', estado: 'autorizada', minutos: 0 });
        } else {
          const minutos = Math.round((HORA_TOLERANCIA_SALIDA - hSalida) * 60);
          minutosDeuda += minutos;
          puntualidad.push({ tipo: 'Salida', estado: 'temprano', minutos: minutos });
        }
      }
    }
    let horasLaboradas = '';
    let minutosExtra = 0;
    const tieneJornadaContinua = !!jornadaContinuaPorDoc[documento];
    const horasAlmuerzoPersona = tieneJornadaContinua ? 0 : HORAS_ALMUERZO_DEFECTO;
    const jornadaHorasPersona  = duracionJornada != null ? (duracionJornada - horasAlmuerzoPersona) : null;
    if (p.Entrada && p.Salida) {
      jornadasCompletas++;
      const hd = Math.max(0, horaADecimal(p.Salida) - horaADecimal(p.Entrada) - horasAlmuerzoPersona);
      totalHoras += hd;
      horasLaboradas = Math.floor(hd) + 'h ' + Math.round((hd - Math.floor(hd)) * 60) + 'm';
      // Solo cuenta como extra lo que exceda la jornada real configurada ese día,
      // y solo si la salida no fue anticipada (ya cubierta arriba como déficit/autorizada).
      if (jornadaHorasPersona != null && p.excepcionSalida !== 'SALIDA_ANTICIPADA_AUTORIZADA' && hd > jornadaHorasPersona) {
        minutosExtra = Math.round((hd - jornadaHorasPersona) * 60);
      }
    }
    filas.push({ documento: documento, nombre: p.nombre, cargo: p.cargo,
                 fincaEntrada: p.fincaEntrada || '', fincaSalida: p.fincaSalida || '',
                 entrada: p.Entrada || '', salida: p.Salida || '', horasLaboradas: horasLaboradas,
                 marcas: marcas, minutosDeuda: minutosDeuda, minutosExtra: minutosExtra, puntualidad: puntualidad,
                 jornadaContinua: tieneJornadaContinua, extraAutorizada: !!p.extraAutorizada });
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
  const diaSemanaHoy = new Date().getDay();
  const horarioHoy = _getHorarioPorDia(diaSemanaHoy, cfg);
  const marcasHoy = {};

  const colMap2  = _getColMarcaciones(hoja);
  const iFecha2  = colMap2['Fecha']       != null ? colMap2['Fecha']       : 1;
  const iHora2   = colMap2['HoraServidor']!= null ? colMap2['HoraServidor']: 2;
  const iDoc2    = colMap2['Documento']   != null ? colMap2['Documento']   : 3;
  const iNombre2 = colMap2['Nombre']      != null ? colMap2['Nombre']      : 4;
  const iCargo2  = colMap2['Cargo']       != null ? colMap2['Cargo']       : 5;
  const iFinca2  = colMap2['Finca']       != null ? colMap2['Finca']       : 6;
  const iTipo2   = colMap2['Tipo']        != null ? colMap2['Tipo']        : 7;

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const fecha = fila[iFecha2], hora = fila[iHora2], nombre = fila[iNombre2];
    const documento = fila[iDoc2], cargo = fila[iCargo2], finca = fila[iFinca2], tipo = fila[iTipo2];
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
    const horasTrab  = salida - entrada;
    let deficitMin = 0, extraMin = 0;
    if (horarioHoy.activo) {
      const hEntrada  = _horaStrADecimal(horarioHoy.entrada || '06:00');
      const hSalida   = _horaStrADecimal(horarioHoy.salida  || '15:00');
      const tolEnt    = (horarioHoy.tolEntrada || 0) / 60;
      const tolSal    = (horarioHoy.tolSalida  || 0) / 60;
      deficitMin = Math.max(0, (hEntrada - tolEnt - entrada) * 60) + Math.max(0, (hSalida - tolSal - salida) * 60);
      extraMin   = Math.max(0, (salida - hSalida) * 60);
    }
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

/** Enlaza el script a tu propio Google Sheet (por ID, tomado de su URL).
 *  Ejemplo: setSheetId('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789') */
function setSheetId(id) {
  const limpio = String(id || '').trim();
  if (!limpio || !/^[a-zA-Z0-9_-]{20,}$/.test(limpio)) throw new Error('Sheet ID inválido');
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', limpio);
  Logger.log('SHEET_ID configurado: ' + limpio);
}

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
  const permitidos = ['empresa','fincaNombre','fincaId','lat','lng','radio','entrada','salida','salidaSab','umbral','horarios'];
  const seguro = {};
  permitidos.forEach(function(k) { if (config[k] != null) seguro[k] = config[k]; });
  PropertiesService.getScriptProperties().setProperty('APP_CONFIG', JSON.stringify(seguro));
  Logger.log('Config guardada: ' + JSON.stringify(seguro));
}

/**
 * Completa la columna Estado en filas de Personal que la tengan vacía.
 * Asigna ACTIVO a las filas sin estado definido.
 * Ejecutar manualmente desde el editor de Apps Script.
 */
function migrarEstadoPersonal() {
  const hoja  = obtenerOhCrearHojaPersonal();
  const datos = hoja.getDataRange().getValues();
  let actualizadas = 0;
  for (let i = 1; i < datos.length; i++) {
    const estado = String(datos[i][5] || '').trim();
    if (!estado) {
      hoja.getRange(i + 1, 6).setValue('ACTIVO');
      actualizadas++;
    }
  }
  if (actualizadas > 0) SpreadsheetApp.flush();
  Logger.log('=== Migración Estado Personal ===');
  Logger.log('Total filas de empleados: ' + (datos.length - 1));
  Logger.log('Filas actualizadas a ACTIVO: ' + actualizadas);
  Logger.log('Filas ya con estado definido: ' + (datos.length - 1 - actualizadas));
  return { total: datos.length - 1, actualizadas: actualizadas };
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

/**
 * Ejecuta y reporta la migración del esquema de Marcaciones.
 * Seguro de ejecutar múltiples veces — no modifica datos, solo agrega columnas faltantes.
 * Ejecutar manualmente desde el editor de Apps Script.
 */
function ejecutarMigracionEsquema() {
  // Abrir directamente — sin pasar por obtenerOhCrearHoja() — para leer el estado real
  // antes de que la migración automática se ejecute.
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  const hoja = ss.getSheetByName(HOJA_MARCACIONES);

  Logger.log('=== Migración Esquema Marcaciones ===');

  if (!hoja) {
    Logger.log('La hoja Marcaciones no existe todavía. Se creará al llamar obtenerOhCrearHoja().');
    obtenerOhCrearHoja();
    Logger.log('Hoja creada con esquema v4 completo (' + COLUMNAS_MARCACIONES_V4.length + ' columnas).');
    return { faltaban: COLUMNAS_MARCACIONES_V4, colMapFinal: _getColMarcaciones(ss.getSheetByName(HOJA_MARCACIONES)) };
  }

  // Capturar estado ANTES de la migración
  const colAntes   = hoja.getLastColumn();
  const filasAntes = hoja.getLastRow() - 1;
  const colMapAntes = _getColMarcaciones(hoja);
  const faltaban   = COLUMNAS_MARCACIONES_V4.filter(function(c) { return colMapAntes[c] == null; });
  const cabAntes   = hoja.getRange(1, 1, 1, colAntes).getValues()[0];

  Logger.log('Columnas antes:         ' + colAntes);
  Logger.log('Cabeceras antes:        ' + JSON.stringify(cabAntes));
  Logger.log('Filas de datos antes:   ' + filasAntes);
  Logger.log('Columnas faltantes:     ' + JSON.stringify(faltaban));

  // Ejecutar migración
  const colMapFinal = migrarEsquemaMarcaciones(hoja);
  const colDespues  = hoja.getLastColumn();
  const filasDesp   = hoja.getLastRow() - 1;
  const cabDespues  = hoja.getRange(1, 1, 1, colDespues).getValues()[0];

  Logger.log('Columnas después:       ' + colDespues);
  Logger.log('Cabeceras después:      ' + JSON.stringify(cabDespues));
  Logger.log('Filas de datos después: ' + filasDesp + ' (deben ser iguales a ' + filasAntes + ')');
  Logger.log('Columnas agregadas:     ' + (colDespues - colAntes));
  Logger.log('colMap final:           ' + JSON.stringify(colMapFinal));

  // Verificar que cada columna canónica tiene su posición
  const problemas = [];
  COLUMNAS_MARCACIONES_V4.forEach(function(c) {
    if (colMapFinal[c] == null) problemas.push('FALTANTE: ' + c);
  });
  if (problemas.length === 0) Logger.log('PASS: todas las columnas canónicas están presentes.');
  else problemas.forEach(function(p) { Logger.log('FAIL: ' + p); });

  // Verificar que los datos históricos no cambiaron (comparar fila 2 si existe)
  if (filasAntes > 0) {
    const filaHistorica = hoja.getRange(2, 1, 1, colAntes).getValues()[0];
    Logger.log('Fila histórica (primeras ' + colAntes + ' celdas): ' + JSON.stringify(filaHistorica));
    Logger.log('Verificar manualmente que estos valores coinciden con los originales.');
  }

  return { faltaban: faltaban, colMapFinal: colMapFinal, colAntes: colAntes, colDespues: colDespues };
}

/**
 * Prueba de idempotencia: envía el mismo payload dos veces con el mismo marcacionId.
 * Resultado esperado:
 *   - Primera llamada: ok:true, idempotente:undefined, una fila nueva en Marcaciones
 *   - Segunda llamada: ok:true, idempotente:true, sin nueva fila
 * REQUISITO: el empleado con documento '99999999' debe existir en Personal,
 * y debe haber un deviceToken válido en DEVICE_TOKEN_TEST en Script Properties.
 * Ejecutar manualmente desde el editor de Apps Script.
 */
function testIdempotencia() {
  Logger.log('=== TEST IDEMPOTENCIA marcacionId ===');

  const hoja     = obtenerOhCrearHoja();
  const filaAntes = hoja.getLastRow();

  // Construir un payload mínimo válido con biometría simulada
  const testId = 'TEST-' + Utilities.getUuid();
  const payload = {
    accion:        'marcar',
    marcacionId:   testId,
    documento:     '99999999',
    tipo:          'Entrada',
    fechaHora:     new Date().toISOString(),
    fechaLocal:    Utilities.formatDate(new Date(), 'America/Bogota', 'yyyy-MM-dd'),
    lat:           0,   lng: 0,
    precisionGPS:  5,
    gpsEstadoActual: 'FUERA',
    distanciaFacial: 0.30,
    sinBiometria:  false,
    appVersion:    '4.0',
    sinConexion:   false,
  };

  // Obtener deviceToken y deviceId de prueba desde Script Properties
  const props    = PropertiesService.getScriptProperties();
  const testTok  = props.getProperty('DEVICE_TOKEN_TEST') || '';
  const testDid  = props.getProperty('DEVICE_ID_TEST')    || '';
  if (!testTok || !testDid) {
    Logger.log('OMITIDO: configura DEVICE_TOKEN_TEST y DEVICE_ID_TEST en Script Properties para ejecutar este test.');
    return;
  }
  payload.deviceToken = testTok;
  payload.deviceId    = testDid;

  // Simular doPost directamente (sin HTTP)
  function simularPost(p) {
    const e = { postData: { contents: JSON.stringify(p) } };
    const resp = doPost(e);
    return JSON.parse(resp.getContent());
  }

  const r1 = simularPost(payload);
  const filasDespues1 = hoja.getLastRow();
  Logger.log('Respuesta 1: ' + JSON.stringify(r1));
  Logger.log('Filas antes: ' + filaAntes + ' | después de envío 1: ' + filasDespues1);

  const r2 = simularPost(payload);
  const filasDespues2 = hoja.getLastRow();
  Logger.log('Respuesta 2: ' + JSON.stringify(r2));
  Logger.log('Filas después de envío 2: ' + filasDespues2);

  Logger.log('--- Resultado ---');
  Logger.log('Primera respuesta ok:          ' + (r1.ok === true  ? 'PASS' : 'FAIL (' + r1.error + ')'));
  Logger.log('Primera NO idempotente:        ' + (!r1.idempotente ? 'PASS' : 'FAIL'));
  Logger.log('Segunda respuesta ok:          ' + (r2.ok === true  ? 'PASS' : 'FAIL (' + r2.error + ')'));
  Logger.log('Segunda idempotente:           ' + (r2.idempotente  ? 'PASS' : 'FAIL'));
  Logger.log('Solo una fila nueva:           ' + (filasDespues2 - filaAntes === 1 ? 'PASS' : 'FAIL (delta=' + (filasDespues2 - filaAntes) + ')'));
  Logger.log('Datos históricos intactos:     ' + (filasDespues2 >= filaAntes ? 'PASS' : 'FAIL'));
}

/**
 * Prueba de zona horaria: verifica que _calcularPuntualidadServidor produce
 * el mismo resultado con cualquier zona horaria del proyecto.
 * No requiere dispositivo ni empleado.
 */
function testZonaHoraria() {
  Logger.log('=== TEST ZONA HORARIA puntualidad ===');

  // Crear una fecha equivalente a las 07:30 Colombia (UTC-5)
  // 07:30 Bogotá = 12:30 UTC
  const ahoraBogota = new Date('2026-01-05T12:30:00Z');
  const horario = { activo: true, entrada: '07:00', salida: '15:00', tolEntrada: 15, tolSalida: 15 };

  const p = _calcularPuntualidadServidor('Entrada', ahoraBogota, horario);
  Logger.log('Hora Bogotá (Utilities): ' + Utilities.formatDate(ahoraBogota, 'America/Bogota', 'HH:mm'));
  Logger.log('Resultado puntualidad:   ' + JSON.stringify(p));
  // 07:30 con tolerancia 15 min sobre entrada 07:00 → límite 07:15 → 15 min tarde
  Logger.log('Estado esperado: tarde | Obtenido: ' + p.estado + ' | ' + (p.estado === 'tarde' ? 'PASS' : 'FAIL'));
  Logger.log('Minutos esperados: 15 | Obtenidos: ' + p.minutosDiferencia + ' | ' + (p.minutosDiferencia === 15 ? 'PASS' : 'FAIL'));

  // Medianoche Colombia: 23:55 Bogotá = 04:55 UTC siguiente día
  const medianoche = new Date('2026-01-06T04:55:00Z');
  const horarioNoche = { activo: true, entrada: '22:00', salida: '06:00', tolEntrada: 10, tolSalida: 10 };
  const p2 = _calcularPuntualidadServidor('Entrada', medianoche, horarioNoche);
  Logger.log('Hora medianoche Bogotá: ' + Utilities.formatDate(medianoche, 'America/Bogota', 'HH:mm'));
  Logger.log('Puntualidad medianoche: ' + JSON.stringify(p2));
}

/**
 * Prueba de migración con hoja antigua de 18 columnas.
 * Crea una hoja temporal MARCACIONES_TEST_18COL, inserta cabeceras antiguas
 * y dos filas históricas, ejecuta migrarEsquemaMarcaciones() y luego inserta
 * una nueva fila usando la lógica colMap para verificar que cada valor queda
 * bajo la cabecera correcta.
 *
 * Al terminar, la hoja TEST permanece para inspección visual.
 * Ejecutar manualmente desde el editor de Apps Script.
 */
function testMigracionEsquemaAntiguo() {
  Logger.log('=== TEST MIGRACIÓN ESQUEMA ANTIGUO (18 columnas) ===');
  const ss        = SpreadsheetApp.openById(SHEET_ID);
  const NOMBRE_TEST = 'MARCACIONES_TEST_18COL';

  // Limpiar hoja de prueba si ya existe
  const hojaVieja = ss.getSheetByName(NOMBRE_TEST);
  if (hojaVieja) ss.deleteSheet(hojaVieja);
  const hoja = ss.insertSheet(NOMBRE_TEST);

  // ── 1. Cabecera antigua de 18 columnas ──
  const cabeceraAntigua = [
    'Fecha','Hora','Nombre','Documento','Cargo','Finca','Tipo',
    'Lat','Lng','DentroGeocerca','DistanciaFacial','Timestamp',
    'DeviceId','PrecisionGPS','AppVersion','ModoOffline','ResultadoFacial','EstadoGPS'
  ];
  hoja.appendRow(cabeceraAntigua);
  hoja.setFrozenRows(1);

  // ── 2. Dos filas históricas ──
  const h1 = ['01/01/2025','06:05:00','Juan Pérez','12345678','Jornalero','La Palma','Entrada',
               4.71, -74.07,'SI',0.25, new Date('2025-01-01T11:05:00Z'),
               'dev-abc','10','3.5','ONLINE','FACIAL','PRECISO'];
  const h2 = ['01/01/2025','14:58:00','Juan Pérez','12345678','Jornalero','La Palma','Salida',
               4.71, -74.07,'SI', 0.27, new Date('2025-01-01T19:58:00Z'),
               'dev-abc','10','3.5','ONLINE','FACIAL','PRECISO'];
  hoja.appendRow(h1);
  hoja.appendRow(h2);
  SpreadsheetApp.flush();
  Logger.log('Filas históricas insertadas: 2 | Columnas antes: ' + hoja.getLastColumn());

  // ── 3. Capturar valores históricos ANTES de migrar ──
  const snapshot = hoja.getRange(2, 1, 2, hoja.getLastColumn()).getValues();

  // ── 4. Migrar esquema ──
  const colMap = migrarEsquemaMarcaciones(hoja);
  Logger.log('Columnas después de migración: ' + hoja.getLastColumn());

  // ── 5. Verificar que los alias quedaron mapeados correctamente ──
  const aliasEsperados = {
    'HoraServidor': 0,   // alias de 'Hora' → índice 1 en antiguo = col B
    'Latitud':      7,   // alias de 'Lat'
    'Longitud':     8,   // alias de 'Lng'
    'FechaSincronizacion': 11, // alias de 'Timestamp'
    'DeviceID':     12,        // alias de 'DeviceId'
    'SinConexion':  15,        // alias de 'ModoOffline'
  };
  Logger.log('--- Verificación de alias ---');
  var pasosAlias = 0, fallosAlias = 0;
  Object.keys(aliasEsperados).forEach(function(canon) {
    const idxEsperado = aliasEsperados[canon];
    const idxObtenido = colMap[canon];
    const ok = idxObtenido === idxEsperado;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' | ' + canon + ': esperado=' + idxEsperado + ' obtenido=' + idxObtenido);
    if (ok) pasosAlias++; else fallosAlias++;
  });

  // ── 6. Insertar nueva fila usando la lógica colMap ──
  const filaTest = new Array(hoja.getLastColumn()).fill('');
  function _t(col, val) { if (colMap[col] != null) filaTest[colMap[col]] = val; }
  const testMarcacionId = 'TEST-MIGR-001';
  _t('MarcacionID',          testMarcacionId);
  _t('Fecha',                '14/07/2026');
  _t('HoraServidor',         '07:30:00');
  _t('Documento',            '99999999');
  _t('Nombre',               'Empleado Prueba');
  _t('Cargo',                'Técnico');
  _t('Finca',                'Palma Grande');
  _t('Tipo',                 'Entrada');
  _t('FechaLocal',           '2026-07-14');
  _t('FechaHoraCliente',     '2026-07-14T12:30:00Z');
  _t('EstadoPuntualidad',    'puntual');
  _t('MinutosDiferencia',    0);
  _t('MensajePuntualidad',   'Entrada a tiempo');
  _t('Latitud',              4.71);
  _t('Longitud',             -74.07);
  _t('PrecisionGPS',         '8.0');
  _t('EstadoGPS',            'PRECISO');
  _t('DistanciaGeocerca',    15);
  _t('DentroGeocerca',       'SI');
  _t('DistanciaFacial',      '0.280');
  _t('SinBiometria',         'NO');
  _t('SupervisorID',         '');
  _t('TipoExcepcion',        '');
  _t('MotivoSupervisor',     '');
  _t('FechaHoraAutorizacion','');
  _t('DeviceID',             'dev-test');
  _t('AppVersion',           '4.0');
  _t('SinConexion',          'ONLINE');
  _t('FechaSincronizacion',  new Date().toISOString());
  _t('ResultadoFacial',      'FACIAL');
  hoja.appendRow(filaTest);
  SpreadsheetApp.flush();

  // ── 7. Leer la fila recién insertada y verificar por nombre de cabecera ──
  Logger.log('--- Verificación de la nueva fila por nombre de cabecera ---');
  const filaLeida = hoja.getRange(hoja.getLastRow(), 1, 1, hoja.getLastColumn()).getValues()[0];
  const comprobaciones = {
    'MarcacionID': testMarcacionId,
    'Fecha':       '14/07/2026',
    'HoraServidor':'07:30:00',
    'Nombre':      'Empleado Prueba',
    'Documento':   '99999999',
    'Latitud':     4.71,
    'Longitud':    -74.07,
    'SinBiometria':'NO',
    'ResultadoFacial':'FACIAL',
    'EstadoGPS':   'PRECISO',
    'DentroGeocerca':'SI',
  };
  var pasos = 0, fallos = 0;
  Object.keys(comprobaciones).forEach(function(col) {
    const idx = colMap[col];
    if (idx == null) { Logger.log('FAIL | ' + col + ': columna no encontrada en colMap'); fallos++; return; }
    const esperado = comprobaciones[col];
    const obtenido = filaLeida[idx];
    const ok       = String(obtenido) === String(esperado);
    Logger.log((ok ? 'PASS' : 'FAIL') + ' | ' + col + ': esperado=[' + esperado + '] obtenido=[' + obtenido + ']');
    if (ok) pasos++; else fallos++;
  });

  // ── 8. Verificar que los registros históricos no cambiaron ──
  Logger.log('--- Verificación de integridad histórica ---');
  const snapshotPost = hoja.getRange(2, 1, 2, 18).getValues(); // solo las 18 cols originales
  var intactos = true;
  for (var r = 0; r < 2; r++) {
    for (var c = 0; c < 18; c++) {
      if (String(snapshotPost[r][c]) !== String(snapshot[r][c])) {
        Logger.log('FAIL | Fila ' + (r+2) + ' col ' + (c+1) + ': antes=[' + snapshot[r][c] + '] después=[' + snapshotPost[r][c] + ']');
        intactos = false;
      }
    }
  }
  if (intactos) Logger.log('PASS | Los dos registros históricos no fueron modificados.');

  Logger.log('--- Resumen ---');
  Logger.log('Alias: ' + pasosAlias + ' PASS / ' + fallosAlias + ' FAIL');
  Logger.log('Columnas nueva fila: ' + pasos + ' PASS / ' + fallos + ' FAIL');
  Logger.log('Integridad histórica: ' + (intactos ? 'PASS' : 'FAIL'));
  Logger.log('Hoja de prueba guardada como "' + NOMBRE_TEST + '" para inspección visual.');
  return { pasosAlias: pasosAlias, fallosAlias: fallosAlias, pasos: pasos, fallos: fallos, intactos: intactos };
}
