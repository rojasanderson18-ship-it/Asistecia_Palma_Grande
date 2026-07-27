/* ── CONFIG ── */

/*
 * DATOS SENSIBLES: ninguno aquí.
 * GS_URL, coordenadas, personal y PIN se cargan desde localStorage('app_config')
 * o desde el backend al inicio. El código fuente es público (GitHub Pages + APK).
 *
 * Estructura de app_config en localStorage:
 * {
 *   gsUrl:       string   — URL del Google Apps Script (se configura en admin)
 *   empresa:     string   — Nombre de la empresa
 *   fincaNombre: string
 *   fincaId:     number
 *   lat:         number
 *   lng:         number
 *   radio:       number   — metros
 *   entrada:     number   — decimal (ej. 6.0 = 6:00 am)
 *   salida:      number
 *   salidaSab:   number
 *   umbral:      number   — distancia facial (0.30–0.60)
 * }
 */

const CONFIG = {
  // GS_URL nunca en código fuente. Se carga desde localStorage en aplicarConfig().
  GS_URL: '',

  EMPRESA: {
    nombre: '',
    nombreCorto: '',
  },

  FINCA: {
    id: 1,
    nombre: '',
    lat: 0,
    lng: 0,
    radioMetros: 200,
  },

  // horarios por día (0=Dom…6=Sáb). Cargado desde backend.
  HORARIOS: [
    { dia: 0, nombre: 'Domingo',    activo: false, entrada: '',      salida: '',      tolEntrada: 10, tolSalida: 5, minutosAlmuerzo: 0 },
    { dia: 1, nombre: 'Lunes',      activo: true,  entrada: '06:30', salida: '14:45', tolEntrada: 10, tolSalida: 5, minutosAlmuerzo: 60 },
    { dia: 2, nombre: 'Martes',     activo: true,  entrada: '06:30', salida: '14:45', tolEntrada: 10, tolSalida: 5, minutosAlmuerzo: 60 },
    { dia: 3, nombre: 'Miércoles',  activo: true,  entrada: '06:30', salida: '14:45', tolEntrada: 10, tolSalida: 5, minutosAlmuerzo: 60 },
    { dia: 4, nombre: 'Jueves',     activo: true,  entrada: '06:30', salida: '14:45', tolEntrada: 10, tolSalida: 5, minutosAlmuerzo: 60 },
    { dia: 5, nombre: 'Viernes',    activo: true,  entrada: '06:30', salida: '15:00', tolEntrada: 10, tolSalida: 5, minutosAlmuerzo: 60 },
    { dia: 6, nombre: 'Sábado',     activo: true,  entrada: '06:30', salida: '12:00', tolEntrada: 10, tolSalida: 5, minutosAlmuerzo: 60 },
  ],

  UMBRAL_FACIAL: 0.56,
};

/* ── Helpers de sanitización ── */
function xh(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function inic(n) { return (n || '').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase(); }

/* ── Personal ── */
// Personal extra agregado desde la app y no sincronizado aún al backend
function getPE() { try { return JSON.parse(localStorage.getItem('personal_extra') || '[]'); } catch { return []; } }
function savePE(l) { localStorage.setItem('personal_extra', JSON.stringify(l)); }

// Personal cacheado desde el backend
function getPersonalCache() { try { return JSON.parse(localStorage.getItem('personal_cache') || '[]'); } catch { return []; } }
function savePersonalCache(l) { localStorage.setItem('personal_cache', JSON.stringify(l)); }

// Personal combinado: cache backend + extra local, sin duplicados de documento
function getPC() {
  const cache = getPersonalCache();
  const extra = getPE();
  const docs = new Set(cache.map(p => String(p.documento)));
  const extraFiltrado = extra.filter(p => !docs.has(String(p.documento)));
  return [...cache, ...extraFiltrado].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

function getCargo(n) { const p = getPC().find(p => p.nombre === n); return p ? p.cargo : ''; }
function getPorDoc(d) { const s = String(d).trim(); return getPC().find(p => String(p.documento) === s); }

/* ── Horario del día ── */
function getHorarioDelDia(dia) {
  const diaN = (dia != null) ? dia : new Date().getDay();
  const cfg = getCfgGuardada();
  const lista = (cfg && cfg.horarios && Array.isArray(cfg.horarios)) ? cfg.horarios : CONFIG.HORARIOS;
  return lista.find(function(h) { return h.dia === diaN; }) || { activo: false };
}

/* ── Rostros biométricos ── */
function getRostros() { try { return JSON.parse(localStorage.getItem('rostros_enrolados') || '{}'); } catch { return {}; } }
function getRostrosMeta() { try { return JSON.parse(localStorage.getItem('rostros_meta') || '{}'); } catch { return {}; } }
function saveRostro(n, d) {
  const r = getRostros(); r[n] = Array.from(d); localStorage.setItem('rostros_enrolados', JSON.stringify(r));
  const m = getRostrosMeta(); m[n] = { v: 2, fecha: new Date().toISOString() }; localStorage.setItem('rostros_meta', JSON.stringify(m));
}
function deleteRostro(n) {
  const r = getRostros(); delete r[n]; localStorage.setItem('rostros_enrolados', JSON.stringify(r));
  const m = getRostrosMeta(); delete m[n]; localStorage.setItem('rostros_meta', JSON.stringify(m));
}

/* ── Configuración persistente ── */
function getCfgGuardada() { try { return JSON.parse(localStorage.getItem('app_config') || 'null'); } catch { return null; } }

function aplicarConfig(cfg) {
  if (!cfg) return;
  if (cfg.gsUrl)        CONFIG.GS_URL = cfg.gsUrl;
  if (cfg.empresa)      { CONFIG.EMPRESA.nombre = cfg.empresa; CONFIG.EMPRESA.nombreCorto = cfg.empresa.split(' ')[0].toUpperCase(); }
  if (cfg.fincaNombre)  CONFIG.FINCA.nombre = cfg.fincaNombre;
  if (cfg.fincaId)      CONFIG.FINCA.id = parseInt(cfg.fincaId);
  if (cfg.lat != null)  CONFIG.FINCA.lat = parseFloat(cfg.lat);
  if (cfg.lng != null)  CONFIG.FINCA.lng = parseFloat(cfg.lng);
  if (cfg.radio)        CONFIG.FINCA.radioMetros = parseInt(cfg.radio);
  if (cfg.horarios && Array.isArray(cfg.horarios)) {
    cfg.horarios.forEach(function(h) {
      const idx = CONFIG.HORARIOS.findIndex(function(d) { return d.dia === h.dia; });
      if (idx >= 0) CONFIG.HORARIOS[idx] = Object.assign({}, CONFIG.HORARIOS[idx], h);
    });
  }
  if (cfg.umbral != null)   CONFIG.UMBRAL_FACIAL = parseFloat(cfg.umbral);
  // cfg.pin permanece solo en localStorage, nunca en CONFIG
}

function aplicarEmpresaUI() {
  const cfg = getCfgGuardada();
  const finca = (cfg && cfg.fincaNombre) ? cfg.fincaNombre : CONFIG.FINCA.nombre;
  const empresa = (cfg && cfg.empresa) ? cfg.empresa : CONFIG.EMPRESA.nombre;
  const el = document.getElementById('nombreFinca');
  const sep = document.querySelector('.hdr-sub-sep');
  const hasF = !!finca;
  if (el) { el.textContent = hasF ? finca : ''; el.style.display = hasF ? '' : 'none'; }
  if (sep) sep.style.display = hasF ? '' : 'none';
  const hdrEmpresa = document.getElementById('hdrEmpresa');
  if (hdrEmpresa) hdrEmpresa.textContent = empresa ? empresa.toUpperCase() : '';
}

/* ── Validación de configuración completa ── */
function isAppConfigured() {
  const cfg = getCfgGuardada();
  if (!cfg) return false;
  const gsUrl = cfg.gsUrl || '';
  if (!gsUrl || !gsUrl.startsWith('https://')) return false;
  if (!cfg.empresa) return false;
  if (!cfg.fincaNombre) return false;
  if (!cfg.lat || !cfg.lng) return false;
  if (!localStorage.getItem('device_token')) return false;
  return true;
}

/* ── Carga de personal desde backend ── */
let _personalCargando = false;

async function cargarPersonalDesdeBackend() {
  if (_personalCargando || !CONFIG.GS_URL) return;
  // Si hay sesión admin activa, usar listarPersonal (catálogo completo).
  // Si solo hay deviceToken, usar sincronizarPersonalKiosco (catálogo ligero, no requiere sesión admin).
  const adminTok  = (typeof getAdminToken === 'function') ? getAdminToken() : null;
  const deviceTok = (typeof getDeviceToken === 'function') ? getDeviceToken() : null;
  if (!adminTok && !deviceTok) return;
  _personalCargando = true;
  const ctrl = new AbortController();
  const timo = setTimeout(() => ctrl.abort(), 12000);
  try {
    let d;
    if (adminTok) {
      const r = await fetch(CONFIG.GS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ accion: 'listarPersonal', token: adminTok }),
        signal: ctrl.signal,
      });
      d = await r.json();
    } else {
      const deviceDid = (typeof getDeviceId === 'function') ? getDeviceId() : null;
      const r = await fetch(CONFIG.GS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ accion: 'sincronizarPersonalKiosco', deviceToken: deviceTok, deviceId: deviceDid }),
        signal: ctrl.signal,
      });
      d = await r.json();
    }
    if (d && Array.isArray(d.personal) && d.personal.length) {
      savePersonalCache(d.personal);
      // Si la pantalla de Gestión de Personal ya estaba abierta cuando terminó
      // la sincronización, refrescar la lista — si no, se queda vacía/vieja
      // hasta que el usuario salga y vuelva a entrar manualmente.
      const pantallaPersonal = document.getElementById('pantallaPersonal');
      if (pantallaPersonal && pantallaPersonal.classList.contains('show') && typeof renderPersonalList === 'function') {
        renderPersonalList();
      }
      if (typeof actualizarMenuAdmin === 'function') actualizarMenuAdmin();
    }
  } catch {
    // Sin conexión o timeout: usa caché existente silenciosamente
  } finally {
    clearTimeout(timo);
    _personalCargando = false;
  }
}

/* ── Sincronización de configuración desde backend ── */
// El backend es la fuente oficial. LocalStorage es solo caché para modo offline.
// gsUrl no se sincroniza desde backend (necesario para conectar al backend).
async function sincronizarConfigDesdeBackend() {
  if (!CONFIG.GS_URL) return;
  const ctrl = new AbortController();
  const timo = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`${CONFIG.GS_URL}?accion=obtenerConfig&_=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.ok && d.config && Object.keys(d.config).length) {
      const prev = getCfgGuardada() || {};
      // Backend sobreescribe campos configurables; gsUrl se preserva (solo local)
      const merged = { ...prev, ...d.config };
      localStorage.setItem('app_config', JSON.stringify(merged));
      aplicarConfig(merged);
      aplicarEmpresaUI();
    }
  } catch {
    // Sin conexión o timeout: la caché local permanece activa
  } finally {
    clearTimeout(timo);
  }
}

/* ── Geocerca/finca propia de este kiosco (sobreescribe la compartida) ── */
// sincronizarConfigDesdeBackend() aplica la configuración GENERAL compartida
// (empresa, horarios, umbral) — pero lat/lng/radio/fincaNombre de ESE
// resultado son los del formulario de Configuración, que es uno solo para
// toda la cuenta. Si este kiosco ya fue autorizado, su geocerca real quedó
// fija en el servidor al tocar "Autorizar este dispositivo", y es la que
// debe usarse aquí — si no, un kiosco ya autorizado se ve DENTRO/FUERA según
// la ubicación que otro kiosco tenga puesta en ese momento en Configuración.
async function sincronizarGeocercaPropia() {
  if (!CONFIG.GS_URL) return;
  const deviceToken = (typeof getDeviceToken === 'function') ? getDeviceToken() : localStorage.getItem('device_token');
  if (!deviceToken) return;
  const deviceId = (typeof _getDeviceId === 'function') ? _getDeviceId() : null;
  if (!deviceId) return;
  const ctrl = new AbortController();
  const timo = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`${CONFIG.GS_URL}?accion=infoDispositivo&deviceToken=${encodeURIComponent(deviceToken)}&deviceId=${encodeURIComponent(deviceId)}&_=${Date.now()}`,
      { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.ok && d.lat != null && d.lng != null) {
      CONFIG.FINCA.lat = parseFloat(d.lat);
      CONFIG.FINCA.lng = parseFloat(d.lng);
      if (d.radio) CONFIG.FINCA.radioMetros = parseInt(d.radio);
      if (d.finca) CONFIG.FINCA.nombre = d.finca;
    }
  } catch {
    // Sin conexión: se mantiene lo último aplicado
  } finally {
    clearTimeout(timo);
  }
}

/* ── Aplicar al iniciar ── */
aplicarConfig(getCfgGuardada());

// aplicarEmpresaUI(), sincronizarConfigDesdeBackend() y
// sincronizarGeocercaPropia() se llaman desde app.js
// cargarPersonalDesdeBackend() se llama desde app.js tras DOMContentLoaded
