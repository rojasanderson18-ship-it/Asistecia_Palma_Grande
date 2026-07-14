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

function obtenerOhCrearHoja() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  let hoja   = ss.getSheetByName(HOJA_MARCACIONES);
  if (!hoja) {
    hoja = ss.insertSheet(HOJA_MARCACIONES);
    hoja.appendRow([
      'MarcacionID','Fecha','HoraServidor','Documento','Nombre','Cargo','Finca','Tipo',
      'FechaLocal','FechaHoraCliente',
      'EstadoPuntualidad','MinutosDiferencia','MensajePuntualidad',
      'Latitud','Longitud','PrecisionGPS','EstadoGPS','DistanciaGeocerca','DentroGeocerca',
      'DistanciaFacial','SinBiometria',
      'SupervisorID','TipoExcepcion','MotivoSupervisor','FechaHoraAutorizacion',
      'DeviceID','AppVersion','SinConexion','FechaSincronizacion','ResultadoFacial'
    ]);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

/* Devuelve un mapa nombre→índice (0-based) leyendo la fila de cabeceras.
   Compatible con el esquema antiguo y el nuevo. */
function _getColMarcaciones(hoja) {
  const headers = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
  const m = {};
  headers.forEach(function(h, i) { m[String(h).trim()] = i; });
  return m;
}

function obtenerOhCrearHojaPersonal() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  let hoja   = ss.getSheetByName(HOJA_PERSONAL);
  if (!hoja) {
    hoja = ss.insertSheet(HOJA_PERSONAL);
    hoja.appendRow(['Documento','Nombre','Cargo','Fecha registro','FotoId','Estado']);
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
function _buscarEmpleado(documento) {
  const doc   = String(documento || '').trim();
  if (!doc) return { ok: false, error: 'Documento requerido' };
  const hoja  = obtenerOhCrearHojaPersonal();
  const datos = hoja.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    if (String(datos[i][0]).trim() === doc) {
      const estado = String(datos[i][5] || 'ACTIVO').trim().toUpperCase();
      if (estado === 'INACTIVO') return { ok: false, error: 'Empleado inactivo. Contacta al administrador.' };
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
  const colMap = _getColMarcaciones(hoja);
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

// Busca una fila por MarcacionID. Devuelve { encontrado, fila, rowIndex } o { encontrado: false }
function _buscarPorMarcacionId(hoja, marcacionId, colMap) {
  if (!marcacionId) return { encontrado: false };
  const datos = hoja.getDataRange().getValues();
  const iMid = colMap['MarcacionID'] != null ? colMap['MarcacionID'] : 0;
  for (let i = 1; i < datos.length; i++) {
    if (String(datos[i][iMid]).trim() === String(marcacionId).trim()) {
      return { encontrado: true, fila: datos[i], rowIndex: i + 1 };
    }
  }
  return { encontrado: false };
}

// Calcula puntualidad oficial en el servidor (America/Bogota)
// Devuelve { estado, mensajePuntualidad, minutosDiferencia }
function _calcularPuntualidadServidor(tipo, ahoraServidor, horarioDia) {
  if (!horarioDia || !horarioDia.activo) {
    return { estado: 'sin_horario', mensajePuntualidad: 'Sin horario configurado', minutosDiferencia: 0 };
  }
  const horaDecimal = ahoraServidor.getHours() + ahoraServidor.getMinutes() / 60;
  if (tipo === 'Entrada') {
    const limiteEntrada = _horaStrADecimal(horarioDia.entrada || '06:00') + (horarioDia.tolEntrada || 0) / 60;
    const diffMin = Math.round((horaDecimal - limiteEntrada) * 60);
    if (diffMin > 0) return { estado: 'tarde', mensajePuntualidad: 'Entrada tarde ' + diffMin + ' min', minutosDiferencia: diffMin };
    return { estado: 'puntual', mensajePuntualidad: 'Entrada a tiempo', minutosDiferencia: 0 };
  } else {
    const limiteSalida = _horaStrADecimal(horarioDia.salida || '15:00') - (horarioDia.tolSalida || 0) / 60;
    const diffMin = Math.round((limiteSalida - horaDecimal) * 60);
    if (diffMin > 0) return { estado: 'temprano', mensajePuntualidad: 'Salida anticipada ' + diffMin + ' min', minutosDiferencia: diffMin };
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
      const permitidos = ['empresa','fincaNombre','fincaId','lat','lng','radio','entrada','salida','salidaSab','umbral','horarios'];
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
                               sanitizarCelda(datos.cargo), new Date(), '', 'ACTIVO']);
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
        const [doc, nombre, cargo, , , estado] = filas[i];
        if (doc && nombre) personal.push({
          documento: String(doc).trim(), nombre: String(nombre).trim(),
          cargo: String(cargo || '').trim(), estado: String(estado || 'ACTIVO').trim()
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

      // ── LockService: serializar solicitudes simultáneas ──
      const lock = LockService.getScriptLock();
      try { lock.waitLock(10000); } catch (e) {
        return _respuestaJson({ ok: false, error: 'El servidor está procesando otra solicitud. Intente nuevamente.' });
      }

      try {
        const hoja   = obtenerOhCrearHoja();
        const colMap = _getColMarcaciones(hoja);

        // ── IDEMPOTENCIA: si ya existe este marcacionId, devolver la fila original ──
        if (marcacionId) {
          const existente = _buscarPorMarcacionId(hoja, marcacionId, colMap);
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

        // Fecha y hora del SERVIDOR (nunca del cliente)
        const ahoraServidor = new Date();
        const hoyStr  = Utilities.formatDate(ahoraServidor, 'America/Bogota', 'dd/MM/yyyy');
        const horaStr = Utilities.formatDate(ahoraServidor, 'America/Bogota', 'HH:mm:ss');

        const marcasDelDia = _obtenerMarcasDelDia(documento, hoyStr);
        const seqVal = _validarSecuencia(marcasDelDia, tipo);
        if (!seqVal.ok) return _respuestaJson({ ok: false, error: seqVal.error });

        // Configuración del servidor
        const appCfg = (function() {
          try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('APP_CONFIG') || '{}'); }
          catch (e) { return {}; }
        })();

        // GPS
        const lat = parseFloat(datos.lat);
        const lng = parseFloat(datos.lng);
        const gpsValido = !isNaN(lat) && !isNaN(lng);
        const geocercaConfigurada = !isNaN(parseFloat(appCfg.lat)) && !isNaN(parseFloat(appCfg.lng));
        let dentroGeocerca = false, distanciaMetros = null;
        let sinConfigGeo = !geocercaConfigurada;
        let gpsAusente = false;

        if (gpsValido && geocercaConfigurada) {
          const geo = _calcularGeocerca(lat, lng);
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
        const finca  = appCfg.fincaNombre || dv.finca || '';

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
        const puntualidad = _calcularPuntualidadServidor(tipo, ahoraServidor, horarioDia);

        // ── Insertar fila con 30 columnas ──
        hoja.appendRow([
          marcacionId,                                                          // MarcacionID
          hoyStr,                                                               // Fecha
          horaStr,                                                              // HoraServidor
          sanitizarCelda(documento),                                            // Documento
          sanitizarCelda(nombre),                                               // Nombre
          sanitizarCelda(cargo),                                                // Cargo
          sanitizarCelda(finca),                                                // Finca
          tipo,                                                                 // Tipo
          sanitizarCelda(String(datos.fechaLocal || '')),                       // FechaLocal
          sanitizarCelda(String(datos.fechaHora  || '')),                       // FechaHoraCliente
          puntualidad.estado,                                                   // EstadoPuntualidad
          puntualidad.minutosDiferencia,                                        // MinutosDiferencia
          puntualidad.mensajePuntualidad,                                       // MensajePuntualidad
          gpsValido ? lat : '',                                                 // Latitud
          gpsValido ? lng : '',                                                 // Longitud
          datos.precisionGPS != null ? parseFloat(datos.precisionGPS).toFixed(1) : '', // PrecisionGPS
          estadoGPS,                                                            // EstadoGPS
          distanciaMetros != null ? distanciaMetros : '',                       // DistanciaGeocerca
          dentroGeocerca ? 'SI' : (gpsAusente ? 'GPS_AUSENTE' : 'NO'),        // DentroGeocerca
          datos.distanciaFacial != null ? parseFloat(datos.distanciaFacial).toFixed(3) : '', // DistanciaFacial
          datos.sinBiometria ? 'SI' : 'NO',                                    // SinBiometria
          sanitizarCelda(String(datos.supervisorId || '')),                     // SupervisorID
          sanitizarCelda(String(datos.tipoExcepcion || '')),                    // TipoExcepcion
          sanitizarCelda(String(datos.motivoSupervisor || '')),                 // MotivoSupervisor
          sanitizarCelda(String(datos.fechaHoraAutorizacion || '')),            // FechaHoraAutorizacion
          sanitizarCelda(dv.deviceId),                                          // DeviceID
          sanitizarCelda(String(datos.appVersion || '')),                       // AppVersion
          datos.sinConexion ? 'OFFLINE' : 'ONLINE',                            // SinConexion
          new Date().toISOString(),                                             // FechaSincronizacion
          resultadoFacial                                                       // ResultadoFacial
        ]);
        SpreadsheetApp.flush();

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
  const fecha = fechaParam || hoy;
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

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const fechaFila = fila[iFecha], hora = fila[iHora], nombre = fila[iNombre];
    const documento = fila[iDoc],   cargo = fila[iCargo], finca = fila[iFinca];
    const tipo      = fila[iTipo];
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
