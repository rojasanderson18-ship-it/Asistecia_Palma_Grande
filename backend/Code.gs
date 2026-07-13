/***********************************************************
 * CONTROL DE ASISTENCIA — Backend Google Apps Script
 *
 * Configuración inicial (ejecutar en el editor de Apps Script):
 *   setPin('1234')             — PIN de administrador
 *   setSupervisorPin('5678')   — PIN de supervisor (diferente al admin)
 *   setConfig({ empresa:'Mi Empresa', fincaNombre:'Sede Principal',
 *               lat:4.710989, lng:-74.072092, radio:200 })
 *
 * Endpoints públicos (kiosco de asistencia, sin auth):
 *   POST accion=marcar          — registrar marcación de trabajador
 *   GET  accion=marcasHoy       — consultar marcaciones del día por documento
 *   GET  accion=obtenerConfig   — configuración de empresa/finca (sin datos personales)
 *
 * Endpoints autenticados con sesión (token de 15 min):
 *   POST accion=login               — iniciar sesión admin → devuelve token
 *   POST accion=loginSupervisor     — iniciar sesión supervisor → token 5 min
 *   POST accion=cambiarPin          — cambiar PIN (token + PIN actual requerido)
 *   POST accion=guardarConfig       — guardar configuración (token)
 *   POST accion=registrarPersonal   — registrar empleado (token)
 *   POST accion=guardarFotoPersonal — guardar foto enrolamiento (token)
 *   POST accion=eliminarPersonal    — eliminar empleado (token)
 *   GET  accion=listarPersonal      — listar empleados con token
 *   GET  accion=resumenDashboard    — resumen del día (token)
 *   GET  accion=obtenerFoto         — servir foto privada de empleado (token)
 ***********************************************************/

const SHEET_ID          = "1ZjIJ_AHty-ltlFDJP_0MV4mIXAhs1oNKhKcYWNMlbC8";
const HOJA_MARCACIONES  = "Marcaciones";
const CACHE_SESSION_TTL = 900;  // 15 minutos sesión admin
const CACHE_SUP_TTL     = 300;  // 5 minutos sesión supervisor
const MAX_INTENTOS_PIN  = 5;
const BLOQUEO_SEGUNDOS  = 600;  // 10 minutos de bloqueo tras 5 intentos fallidos

/* ══════════════════════════════════════════════════════
   HELPERS: respuesta, PIN, sesión, rate limiting
══════════════════════════════════════════════════════ */

function _respuestaJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

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

/* ── Sesiones ── */

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
  if (rolesPermitidos && rolesPermitidos.indexOf(s.role) === -1) {
    return { ok: false, error: 'Acceso no autorizado para este rol.' };
  }
  return { ok: true, role: s.role };
}

/* ── Rate limiting ── */

function _rlKey(deviceId) {
  return 'RL_' + String(deviceId || 'def').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

function _checkRateLimit(deviceId) {
  const raw = CacheService.getScriptCache().get(_rlKey(deviceId));
  if (!raw) return { blocked: false };
  const d = JSON.parse(raw);
  if (d.blockedUntil && new Date() < new Date(d.blockedUntil)) {
    return { blocked: true, error: 'Demasiados intentos fallidos. Intenta en 10 minutos.' };
  }
  return { blocked: false, count: d.count || 0 };
}

function _registrarIntentoFallido(deviceId) {
  const cache = CacheService.getScriptCache();
  const key   = _rlKey(deviceId);
  const raw   = cache.get(key);
  const d     = raw ? JSON.parse(raw) : { count: 0 };
  if (d.blockedUntil && new Date() >= new Date(d.blockedUntil)) d.count = 0;
  d.count = (d.count || 0) + 1;
  d.lastAttempt = new Date().toISOString();
  if (d.count >= MAX_INTENTOS_PIN) {
    d.blockedUntil = new Date(Date.now() + BLOQUEO_SEGUNDOS * 1000).toISOString();
    d.count = 0;
    cache.put(key, JSON.stringify(d), BLOQUEO_SEGUNDOS + 120);
  } else {
    cache.put(key, JSON.stringify(d), BLOQUEO_SEGUNDOS + 120);
  }
}

function _resetRateLimit(deviceId) {
  CacheService.getScriptCache().remove(_rlKey(deviceId));
}

/* ══════════════════════════════════════════════════════
   HELPERS: hojas y archivos
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
                    'Lat','Lng','DentroGeocerca','DistanciaFacial','Timestamp']);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function obtenerOhCrearCarpetaFotos() {
  const carpetas = DriveApp.getFoldersByName('Fotos_Asistencia');
  if (carpetas.hasNext()) return carpetas.next();
  return DriveApp.createFolder('Fotos_Asistencia');
}

// Guarda la foto en Drive SIN compartir públicamente.
// Devuelve el file ID (no una URL pública).
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
    // Sin acceso público — las fotos se sirven únicamente mediante obtenerFoto (autenticado)
    return archivo.getId();
  } catch (err) {
    Logger.log('Error guardando foto: ' + err.message);
    throw err;
  }
}

function obtenerOhCrearHojaPersonal() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  let hoja   = ss.getSheetByName('Personal');
  if (!hoja) {
    hoja = ss.insertSheet('Personal');
    hoja.appendRow(['Documento','Nombre','Cargo','Fecha registro','FotoId']);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

// Acepta file ID directo o URL antigua de Drive (compatibilidad hacia atrás)
function borrarFotoAnterior(fotoIdOUrl) {
  if (!fotoIdOUrl) return;
  try {
    let id = String(fotoIdOUrl);
    if (id.startsWith('https://')) {
      const m = id.match(/id=([a-zA-Z0-9_-]+)/);
      if (!m) return;
      id = m[1];
    }
    DriveApp.getFileById(id).setTrashed(true);
  } catch (e) { /* archivo ya eliminado o sin permisos */ }
}

function guardarFotoPersonal(documento, fotoDataUrl, nombre, cargo) {
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
  // Primera vez — crear la fila
  const fotoId = guardarFoto(fotoDataUrl, documento, 'Enrolamiento');
  hoja.appendRow([
    sanitizarCelda(String(documento)),
    sanitizarCelda(nombre || ''),
    sanitizarCelda(cargo  || ''),
    new Date(),
    fotoId
  ]);
  SpreadsheetApp.flush();
  return fotoId;
}

// Devuelve mapa documento → file ID (o URL antigua) de foto
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
   doPost
══════════════════════════════════════════════════════ */

function doPost(e) {
  try {
    const datos = JSON.parse(e.postData.contents);

    /* ── Autenticación admin ── */
    if (datos.accion === 'login') {
      const deviceId = String(datos.deviceId || 'unknown').slice(0, 64);
      const rl = _checkRateLimit(deviceId);
      if (rl.blocked) return _respuestaJson({ ok: false, error: rl.error });
      const v = _verificarPin(datos.hash);
      if (!v.ok) {
        _registrarIntentoFallido(deviceId);
        return _respuestaJson({ ok: false, error: v.error });
      }
      _resetRateLimit(deviceId);
      const token = _generarToken();
      _guardarSesion(token, 'admin', CACHE_SESSION_TTL);
      return _respuestaJson({ ok: true, token: token, role: 'admin', expiresIn: CACHE_SESSION_TTL });
    }

    /* ── Autenticación supervisor ── */
    if (datos.accion === 'loginSupervisor') {
      const deviceId = String(datos.deviceId || 'unknown').slice(0, 64) + '_sup';
      const rl = _checkRateLimit(deviceId);
      if (rl.blocked) return _respuestaJson({ ok: false, error: rl.error });
      const v = _verificarPinSupervisor(datos.hash);
      if (!v.ok) {
        _registrarIntentoFallido(deviceId);
        return _respuestaJson({ ok: false, error: v.error });
      }
      _resetRateLimit(deviceId);
      const token = _generarToken();
      _guardarSesion(token, 'supervisor', CACHE_SUP_TTL);
      return _respuestaJson({ ok: true, token: token, role: 'supervisor', expiresIn: CACHE_SUP_TTL });
    }

    /* ── Cambiar PIN (requiere sesión admin + PIN actual) ── */
    if (datos.accion === 'cambiarPin') {
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
    if (datos.accion === 'guardarConfig') {
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
    if (datos.accion === 'registrarPersonal') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      const hojaPersonal = obtenerOhCrearHojaPersonal();
      const existentes   = hojaPersonal.getDataRange().getValues();
      const docNuevo     = String(datos.documento || '').trim();
      for (let i = 1; i < existentes.length; i++) {
        if (String(existentes[i][0]).trim() === docNuevo) {
          return _respuestaJson({ ok: false, error: 'Ya existe una persona con ese documento' });
        }
      }
      hojaPersonal.appendRow([
        sanitizarCelda(datos.documento || ''),
        sanitizarCelda(datos.nombre),
        sanitizarCelda(datos.cargo),
        new Date(),
        ''
      ]);
      return _respuestaJson({ ok: true });
    }

    /* ── Guardar foto de enrolamiento (requiere sesión admin) ── */
    if (datos.accion === 'guardarFotoPersonal') {
      const sv = _validarSesion(datos.token, ['admin']);
      if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
      guardarFotoPersonal(datos.documento, datos.foto, datos.nombre, datos.cargo);
      return _respuestaJson({ ok: true });
    }

    /* ── Eliminar personal (requiere sesión admin) ── */
    if (datos.accion === 'eliminarPersonal') {
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
          return _respuestaJson({ ok: true });
        }
      }
      return _respuestaJson({ ok: false, error: 'Empleado no encontrado' });
    }

    /* ── Marcación de asistencia (público — kiosco) ── */
    const hoja      = obtenerOhCrearHoja();
    const fechaHora = new Date(datos.fechaHora);
    hoja.appendRow([
      Utilities.formatDate(fechaHora, 'America/Bogota', 'dd/MM/yyyy'),
      Utilities.formatDate(fechaHora, 'America/Bogota', 'HH:mm:ss'),
      sanitizarCelda(datos.nombre),
      sanitizarCelda(datos.documento || ''),
      sanitizarCelda(datos.cargo    || ''),
      sanitizarCelda(datos.finca),
      sanitizarCelda(datos.tipo),
      datos.lat || '',
      datos.lng || '',
      datos.dentroGeocerca ? 'SI' : 'NO',
      datos.distanciaFacial ? datos.distanciaFacial.toFixed(3) : '',
      new Date()
    ]);
    if (datos.tipo === 'Salida') calcularResumenDiario();
    return _respuestaJson({ ok: true });

  } catch (err) {
    return _respuestaJson({ ok: false, error: err.message });
  }
}

/* ══════════════════════════════════════════════════════
   doGet
══════════════════════════════════════════════════════ */

function normalizarFecha(valor) {
  if (Object.prototype.toString.call(valor) === '[object Date]') {
    return Utilities.formatDate(valor, 'America/Bogota', 'dd/MM/yyyy');
  }
  return String(valor);
}

function normalizarHora(valor) {
  if (Object.prototype.toString.call(valor) === '[object Date]') {
    return Utilities.formatDate(valor, 'America/Bogota', 'HH:mm:ss');
  }
  return String(valor);
}

function doGet(e) {
  const accion = e.parameter && e.parameter.accion;

  /* ── Marcas del día (público — kiosco) ── */
  if (accion === 'marcasHoy') {
    const documento = String(e.parameter.documento || '').trim();
    const hoja  = obtenerOhCrearHoja();
    const datos = hoja.getDataRange().getValues();
    const hoy   = Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy');
    const marcas = [];
    for (let i = 1; i < datos.length; i++) {
      const [fecha, , , doc, , , tipo] = datos[i];
      if (normalizarFecha(fecha) === hoy && String(doc) === documento) marcas.push(tipo);
    }
    return _respuestaJson({ ok: true, marcas: marcas });
  }

  /* ── Configuración pública (público — sin datos personales) ── */
  if (accion === 'obtenerConfig') {
    const props = PropertiesService.getScriptProperties();
    let config  = {};
    try { const raw = props.getProperty('APP_CONFIG'); if (raw) config = JSON.parse(raw); } catch (ex) {}
    return _respuestaJson({ ok: true, config: config });
  }

  /* ── Listar personal (requiere sesión admin) ── */
  if (accion === 'listarPersonal') {
    const sv = _validarSesion(e.parameter.token, ['admin']);
    if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
    const hoja  = obtenerOhCrearHojaPersonal();
    const datos = hoja.getDataRange().getValues();
    const personal = [];
    for (let i = 1; i < datos.length; i++) {
      const [doc, nombre, cargo] = datos[i];
      if (doc && nombre) personal.push({
        documento: String(doc).trim(),
        nombre:    String(nombre).trim(),
        cargo:     String(cargo || '').trim()
      });
    }
    return _respuestaJson({ ok: true, personal: personal });
  }

  /* ── Foto de empleado (requiere sesión admin o supervisor) ── */
  if (accion === 'obtenerFoto') {
    const sv = _validarSesion(e.parameter.token, ['admin', 'supervisor']);
    if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
    const documento = String(e.parameter.documento || '').trim();
    if (!documento) return _respuestaJson({ ok: false, error: 'documento requerido' });
    const fotos  = obtenerFotosPorDocumento();
    const fotoId = fotos[documento];
    if (!fotoId) return _respuestaJson({ ok: false, error: 'Sin foto registrada' });
    try {
      // Soporta file ID directo o URL antigua
      let id = String(fotoId);
      if (id.startsWith('https://')) {
        const m = id.match(/id=([a-zA-Z0-9_-]+)/);
        if (!m) return _respuestaJson({ ok: false, error: 'Formato de foto no reconocido' });
        id = m[1];
      }
      const file = DriveApp.getFileById(id);
      const blob = file.getBlob();
      return _respuestaJson({
        ok: true,
        b64: Utilities.base64Encode(blob.getBytes()),
        mimeType: blob.getContentType()
      });
    } catch (ex) {
      return _respuestaJson({ ok: false, error: 'No se pudo obtener la foto' });
    }
  }

  /* ── Resumen dashboard (requiere sesión admin) ── */
  if (accion === 'resumenDashboard') {
    const sv = _validarSesion(e.parameter.token, ['admin']);
    if (!sv.ok) return _respuestaJson({ ok: false, error: sv.error });
    return calcularResumenDashboard(e.parameter.fecha);
  }

  return _respuestaJson({ status: 'Control_Asistencia backend activo' });
}

/* ══════════════════════════════════════════════════════
   REPORTES Y RESUMEN DIARIO
══════════════════════════════════════════════════════ */

function calcularResumenDashboard(fechaParam) {
  const hoy   = Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy');
  const fecha = fechaParam || hoy;
  const hoja  = obtenerOhCrearHoja();
  const datos = hoja.getDataRange().getValues();
  const HORA_TOLERANCIA_ENTRADA = 6.25;
  const porPersona = {};

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const [fechaFila, hora, nombre, documento, cargo, finca, tipo] = fila;
    if (normalizarFecha(fechaFila) !== fecha) continue;
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
      const partes = String(p.Entrada).split(':').map(Number);
      if ((partes[0] + partes[1] / 60) > HORA_TOLERANCIA_ENTRADA) tardanzas++;
    }
    let horasLaboradas = '';
    if (p.Entrada && p.Salida) {
      jornadasCompletas++;
      const hd = horaADecimal(p.Salida) - horaADecimal(p.Entrada);
      totalHoras += hd;
      horasLaboradas = Math.floor(hd) + 'h ' + Math.round((hd - Math.floor(hd)) * 60) + 'm';
    }
    filas.push({
      documento: documento, nombre: p.nombre, cargo: p.cargo, finca: p.finca,
      entrada: p.Entrada || '', salida: p.Salida || '', horasLaboradas: horasLaboradas
    });
  });

  return _respuestaJson({
    ok: true, fecha: fecha,
    totalPersonas: Object.keys(porPersona).length,
    tardanzas: tardanzas, jornadasCompletas: jornadasCompletas,
    totalHoras: totalHoras.toFixed(1),
    porFinca: porFinca, filas: filas
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
  const HORARIO = { entrada: 6.0, salida: 14.75, salidaSabado: 11.75 };
  const marcasHoy = {};

  for (let i = 1; i < datos.length; i++) {
    const [fecha, hora, nombre, documento, cargo, finca, tipo] = datos[i];
    if (normalizarFecha(fecha) !== hoy) continue;
    const clave = nombre + '|' + finca;
    if (!marcasHoy[clave]) marcasHoy[clave] = { cargo: cargo, documento: documento };
    marcasHoy[clave][tipo] = normalizarHora(hora);
  }

  const filasNuevas = [];
  Object.keys(marcasHoy).forEach(function(clave) {
    const partes = clave.split('|');
    const nombre = partes[0], finca = partes[1];
    const m = marcasHoy[clave];
    if (!m['Entrada'] || !m['Salida']) {
      filasNuevas.push([hoy, nombre, m.documento || '', m.cargo || '', finca,
                        m['Entrada'] || '', m['Salida'] || '', 'INCOMPLETO', '', '']);
      return;
    }
    const horaADecimal = function(hStr) {
      const p = hStr.split(':').map(Number); return p[0] + p[1]/60 + p[2]/3600;
    };
    const entrada      = horaADecimal(m['Entrada']);
    const salida       = horaADecimal(m['Salida']);
    const esSabado     = new Date().getDay() === 6;
    const horaCierre   = esSabado ? HORARIO.salidaSabado : HORARIO.salida;
    const horasTrab    = salida - entrada;
    const deficitMin   = Math.max(0, (HORARIO.entrada - entrada) * 60)
                       + Math.max(0, (horaCierre - salida) * 60);
    const extraMin     = Math.max(0, (salida - horaCierre) * 60);
    filasNuevas.push([hoy, nombre, m.documento || '', m.cargo || '', finca,
                      m['Entrada'], m['Salida'], horasTrab.toFixed(2),
                      deficitMin.toFixed(0), extraMin.toFixed(0)]);
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

/**
 * Configura el PIN de administrador.
 * Ejemplo: setPin('1234')
 */
function setPin(pin) {
  if (!pin || !/^\d{4,8}$/.test(String(pin))) throw new Error('PIN: 4–8 dígitos');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pin))
    .map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); })
    .join('');
  PropertiesService.getScriptProperties().setProperty('PIN_HASH', hash);
  Logger.log('PIN admin configurado.');
}

/**
 * Configura el PIN de supervisor (diferente al admin).
 * Ejemplo: setSupervisorPin('5678')
 */
function setSupervisorPin(pin) {
  if (!pin || !/^\d{4,8}$/.test(String(pin))) throw new Error('PIN: 4–8 dígitos');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pin))
    .map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); })
    .join('');
  PropertiesService.getScriptProperties().setProperty('SUPERVISOR_PIN_HASH', hash);
  Logger.log('PIN supervisor configurado.');
}

/**
 * Configura los parámetros de la empresa.
 * Ejemplo: setConfig({ empresa:'Mi Empresa', fincaNombre:'Sede', lat:4.71, lng:-74.07, radio:200 })
 */
function setConfig(config) {
  const permitidos = ['empresa','fincaNombre','fincaId','lat','lng','radio','entrada','salida','salidaSab','umbral'];
  const seguro = {};
  permitidos.forEach(function(k) { if (config[k] != null) seguro[k] = config[k]; });
  PropertiesService.getScriptProperties().setProperty('APP_CONFIG', JSON.stringify(seguro));
  Logger.log('Config guardada: ' + JSON.stringify(seguro));
}
