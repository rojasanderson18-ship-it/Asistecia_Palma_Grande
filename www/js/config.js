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
    nombre: 'Mi Empresa',
    nombreCorto: 'EMPRESA',
  },

  FINCA: {
    id: 1,
    nombre: 'Sin configurar',
    lat: 0,
    lng: 0,
    radioMetros: 200,
  },

  HORARIO: {
    entrada: 6.0,
    salida: 15.0,
    salidaSabado: 12.0,
  },

  UMBRAL_FACIAL: 0.45,
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
  if (cfg.entrada != null)  CONFIG.HORARIO.entrada = cfg.entrada;
  if (cfg.salida != null)   CONFIG.HORARIO.salida = cfg.salida;
  if (cfg.salidaSab != null) CONFIG.HORARIO.salidaSabado = cfg.salidaSab;
  if (cfg.umbral != null)   CONFIG.UMBRAL_FACIAL = parseFloat(cfg.umbral);
  // cfg.pin permanece solo en localStorage, nunca en CONFIG
}

function aplicarEmpresaUI() {
  const cfg = getCfgGuardada();
  const finca = (cfg && cfg.fincaNombre) ? cfg.fincaNombre : CONFIG.FINCA.nombre;
  const empresa = (cfg && cfg.empresa) ? cfg.empresa : CONFIG.EMPRESA.nombre;
  const el = document.getElementById('nombreFinca');
  if (el) el.textContent = finca;
  const hdrEmpresa = document.getElementById('hdrEmpresa');
  if (hdrEmpresa) hdrEmpresa.textContent = empresa.toUpperCase();
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
  try {
    let d;
    if (adminTok) {
      const r = await fetch(CONFIG.GS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ accion: 'listarPersonal', token: adminTok }),
      });
      d = await r.json();
    } else {
      const deviceDid = (typeof getDeviceId === 'function') ? getDeviceId() : null;
      const r = await fetch(CONFIG.GS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ accion: 'sincronizarPersonalKiosco', deviceToken: deviceTok, deviceId: deviceDid }),
      });
      d = await r.json();
    }
    if (d && Array.isArray(d.personal) && d.personal.length) {
      savePersonalCache(d.personal);
    }
  } catch {
    // Sin conexión: usa caché existente silenciosamente
  } finally {
    _personalCargando = false;
  }
}

/* ── Sincronización de configuración desde backend ── */
// El backend es la fuente oficial. LocalStorage es solo caché para modo offline.
// gsUrl no se sincroniza desde backend (necesario para conectar al backend).
async function sincronizarConfigDesdeBackend() {
  if (!CONFIG.GS_URL) return;
  try {
    const r = await fetch(`${CONFIG.GS_URL}?accion=obtenerConfig&_=${Date.now()}`, { cache: 'no-store' });
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
    // Sin conexión: la caché local permanece activa
  }
}

/* ── Aplicar al iniciar ── */
aplicarConfig(getCfgGuardada());

// aplicarEmpresaUI() y sincronizarConfigDesdeBackend() se llaman desde app.js
// cargarPersonalDesdeBackend() se llama desde app.js tras DOMContentLoaded
