/* ── CONFIG ── */
const CONFIG = {
  GS_URL: "https://script.google.com/macros/s/AKfycbzCdKT63tnUe07VNNoTUotbiY_Vr8wrf7HA5d0CUU-squZJBbTNIYDTnT9cn9aqJElM/exec",
  FINCA: {id:2, nombre:"Finca 2", lat:2.722853, lng:-72.735464, radioMetros:100},
  PERSONAL_BASE: [
    {documento:"1121816934",nombre:"Rusbel Reynel Algarra Salgado",cargo:"Conductor"},
    {documento:"1120926454",nombre:"Dubian Camilo Cuervo Gomez",cargo:"Auxiliar de Sanidad"},
    {documento:"1123162209",nombre:"Arnol Neyer Escamilla Gil",cargo:"Sup. Sanidad Plantacion"},
    {documento:"1122655798",nombre:"Ricardo Gaitan Cleves",cargo:"Auxiliar de Sanidad"},
    {documento:"1063282651",nombre:"Leanis Yulieth Garizao Argumedo",cargo:"Almacenista"},
    {documento:"1093738385",nombre:"Fernando Francisco Leon Suarez",cargo:"Operario Tractor"},
    {documento:"79728288",nombre:"Juan Carlos Oviedo Castillejo",cargo:"Sup. Cultivo"},
    {documento:"1120924351",nombre:"Alix Viviana Peña Garzon",cargo:"Sup. Cultivo"},
    {documento:"1006534617",nombre:"Ayler Perez Guzman",cargo:"Auxiliar de Sanidad"},
    {documento:"82391042",nombre:"Ciro Alfonso Romero Ramos",cargo:"Auxiliar de Sanidad"},
    {documento:"1006810316",nombre:"Luis Fernando Sanchez Chitiva",cargo:"Director Tecnico"},
    {documento:"86010042",nombre:"Jose Oswaldo Sanchez Martinez",cargo:"Operario Tractor"},
    {documento:"11434440",nombre:"Edgar Alfonso Tinjaca Niño",cargo:"Jefe de Taller"},
    {documento:"79978603",nombre:"Jurley Trujillo Fernandez",cargo:"Auxiliar de Sanidad"},
    {documento:"15174884",nombre:"Johony Manuel Valdez Yance",cargo:"Auxiliar de Sanidad"},
    {documento:"1066269860",nombre:"Saul Camilo Vega Gutierrez",cargo:"Auxiliar de Sanidad"},
    {documento:"1121884438",nombre:"Nayiver Ercilia Vergara Alvarez",cargo:"Auxiliar Administrativa"},
    {documento:"78715610",nombre:"Cesar Alberto Verona Monterrosa",cargo:"Operario Tractor"},
    {documento:"1121944143",nombre:"Anderson Gonzalo Rojas Rojas",cargo:"Superintendente"},
    {documento:"17417318",nombre:"Ever Ferney Cleves Florez",cargo:"Operario Tractor"},
    {documento:"7392093",nombre:"Sandro Edison Bonilla Parra",cargo:"Operario Tractor"},
    {documento:"1193447192",nombre:"Brayan Farid Perez Avendaño",cargo:"Supervisor"},
    {documento:"1120560605",nombre:"John Fredy Garnica Buitrago",cargo:"Operario Tractor"},
    {documento:"1007294977",nombre:"Mabel Gisette Romero Guerrero",cargo:"Auxiliar HSEQ"},
    {documento:"1120365099",nombre:"Julio Cesar Bacca Moreno",cargo:"Operario Tractor"},
    {documento:"1192803681",nombre:"Andres Felipe Fajardo Cardenas",cargo:"Supervisor"},
    {documento:"1006879326",nombre:"Juan David Guiza Fajardo",cargo:"Auxiliar de Sanidad"},
    {documento:"1001933516",nombre:"Sebastian Rafael Celedon Moreno",cargo:"Auxiliar de Sanidad"},
    {documento:"4428130",nombre:"Tulio Antonio Olaya Gonzalez",cargo:"Mecanico Integral"}
  ],
  HORARIO: {entrada:6.0, salida:14.75, salidaSabado:11.75},
  UMBRAL_FACIAL: 0.45,
  ALMUERZO_MIN: 60
};

// PIN no está en el código fuente — solo en localStorage.
// TODO: mover validación de PIN al backend (endpoint GAS) para mayor seguridad.
function validatePin(pin) {
  try {
    const cfg = JSON.parse(localStorage.getItem('app_config') || 'null');
    const stored = cfg && cfg.pin ? cfg.pin : null;
    if (!stored) return false;
    return pin === stored;
  } catch { return false; }
}

function xh(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function inic(n) { return (n || '').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase(); }
function getPE() { try { return JSON.parse(localStorage.getItem('personal_extra') || '[]'); } catch { return []; } }
function savePE(l) { localStorage.setItem('personal_extra', JSON.stringify(l)); }
function getPC() { return [...CONFIG.PERSONAL_BASE, ...getPE()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')); }
function getCargo(n) { const p = getPC().find(p => p.nombre === n); return p ? p.cargo : ''; }
function getPorDoc(d) { const s = String(d).trim(); return getPC().find(p => String(p.documento) === s); }
function getRostros() { try { return JSON.parse(localStorage.getItem('rostros_enrolados') || '{}'); } catch { return {}; } }
function getRostrosMeta() { try { return JSON.parse(localStorage.getItem('rostros_meta') || '{}'); } catch { return {}; } }
function saveRostro(n, d) {
  const r = getRostros(); r[n] = Array.from(d); localStorage.setItem('rostros_enrolados', JSON.stringify(r));
  const m = getRostrosMeta(); m[n] = {v:2, fecha: new Date().toISOString()}; localStorage.setItem('rostros_meta', JSON.stringify(m));
}
function deleteRostro(n) {
  const r = getRostros(); delete r[n]; localStorage.setItem('rostros_enrolados', JSON.stringify(r));
  const m = getRostrosMeta(); delete m[n]; localStorage.setItem('rostros_meta', JSON.stringify(m));
}
function getCfgGuardada() { try { return JSON.parse(localStorage.getItem('app_config') || 'null'); } catch { return null; } }
function aplicarConfig(cfg) {
  if (!cfg) return;
  if (cfg.nombreFinca) { CONFIG.FINCA.nombre = cfg.nombreFinca; const el = document.getElementById('nombreFinca'); if (el) el.textContent = cfg.nombreFinca; }
  if (cfg.lat != null) CONFIG.FINCA.lat = parseFloat(cfg.lat);
  if (cfg.lng != null) CONFIG.FINCA.lng = parseFloat(cfg.lng);
  if (cfg.radio) CONFIG.FINCA.radioMetros = parseInt(cfg.radio);
  if (cfg.entrada != null) CONFIG.HORARIO.entrada = cfg.entrada;
  if (cfg.salida != null) CONFIG.HORARIO.salida = cfg.salida;
  if (cfg.salidaSab != null) CONFIG.HORARIO.salidaSabado = cfg.salidaSab;
  if (cfg.umbral != null) CONFIG.UMBRAL_FACIAL = parseFloat(cfg.umbral);
  if (cfg.almuerzoMin != null) CONFIG.ALMUERZO_MIN = parseInt(cfg.almuerzoMin);
  // cfg.pin remains in localStorage only, never in CONFIG
}

// Apply saved config at startup
aplicarConfig(getCfgGuardada());
