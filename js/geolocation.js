/* ── MÓDULO: Geolocalización ── */

// Estado GPS explícito: BUSCANDO | DENTRO | FUERA | SIN_PERMISO | NO_DISPONIBLE | ERROR
let gpsEstado = 'BUSCANDO';
let gpsOk     = false;   // retrocompat: true solo cuando DENTRO
let gpsCoords = null;
let _gpsWatchId   = null;
let _gpsRetryTimer = null;

/* ── Etiquetas por estado ── */
const GPS_INFO = {
  BUSCANDO:      { txt: 'Buscando ubicación…', cls: 'na',  geo: '—',    geoCls: 'na'  },
  DENTRO:        { txt: 'Dentro',              cls: 'ok',  geo: 'OK',   geoCls: 'ok'  },
  FUERA:         { txt: 'Fuera',               cls: 'er',  geo: 'Fuera',geoCls: 'er'  },
  SIN_PERMISO:   { txt: 'Sin permiso GPS',     cls: 'er',  geo: '—',    geoCls: 'na'  },
  NO_DISPONIBLE: { txt: 'GPS no disponible',   cls: 'er',  geo: '—',    geoCls: 'na'  },
  ERROR:         { txt: 'Error GPS',           cls: 'er',  geo: '—',    geoCls: 'na'  },
};

function _aplicarEstadoGPS(estado) {
  gpsEstado = estado;
  gpsOk     = estado === 'DENTRO';

  const info = GPS_INFO[estado] || GPS_INFO.ERROR;

  // Strip geo (pantalla inicial)
  const strip = document.getElementById('geoBadge');
  const txtEl = document.getElementById('geoTxt');
  if (strip) strip.className = 'geo-strip ' + (gpsOk ? 'ok' : estado === 'BUSCANDO' ? '' : 'er');
  if (txtEl) {
    txtEl.textContent = gpsOk
      ? 'Dentro del predio'
      : estado === 'BUSCANDO'
        ? 'Verificando ubicación…'
        : estado === 'SIN_PERMISO'
          ? 'Sin permiso de ubicación'
          : estado === 'NO_DISPONIBLE'
            ? 'GPS no disponible'
            : 'Fuera de geocerca';
  }

  // Panel de detalle
  const stUb  = document.getElementById('stUbicacion');
  const stGeo = document.getElementById('stGeocerca');
  if (stUb)  { stUb.textContent  = info.txt;    stUb.className  = 'st-val ' + info.cls;    }
  if (stGeo) { stGeo.textContent = info.geo;    stGeo.className = 'st-val ' + info.geoCls; }
}

/* ── Cálculo de distancia haversine ── */
function _calcularDistancia(lat1, lng1, lat2, lng2) {
  const R = 6371000, tr = x => x * Math.PI / 180;
  const dLa = tr(lat2 - lat1), dLo = tr(lng2 - lng1);
  const a = Math.sin(dLa/2)**2 + Math.cos(tr(lat1)) * Math.cos(tr(lat2)) * Math.sin(dLo/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── Procesar posición recibida ── */
function _onPosicion(pos) {
  if (_gpsRetryTimer) { clearTimeout(_gpsRetryTimer); _gpsRetryTimer = null; }
  gpsCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude, precision: pos.coords.accuracy };

  // Sin geocerca configurada → no forzar error
  if (!CONFIG.FINCA.lat && !CONFIG.FINCA.lng) {
    _aplicarEstadoGPS('DENTRO');
    return;
  }

  const dist = _calcularDistancia(pos.coords.latitude, pos.coords.longitude, CONFIG.FINCA.lat, CONFIG.FINCA.lng);
  _aplicarEstadoGPS(dist <= CONFIG.FINCA.radioMetros ? 'DENTRO' : 'FUERA');
}

/* ── Manejar error de geolocalización ── */
function _onErrorGPS(err) {
  gpsCoords = null;
  let estado;
  if (err && err.code === 1)      estado = 'SIN_PERMISO';
  else if (err && err.code === 2) estado = 'NO_DISPONIBLE';
  else                            estado = 'ERROR';
  _aplicarEstadoGPS(estado);

  // Reintentar en 8s (excepto permiso denegado — solo cambia si el usuario activa)
  if (estado !== 'SIN_PERMISO') {
    _gpsRetryTimer = setTimeout(_iniciarWatchGPS, 8000);
  }
}

/* ── Iniciar watchPosition (un único watcher activo) ── */
function _iniciarWatchGPS() {
  if (!navigator.geolocation) { _aplicarEstadoGPS('NO_DISPONIBLE'); return; }

  // Cancelar watcher previo
  if (_gpsWatchId !== null) {
    navigator.geolocation.clearWatch(_gpsWatchId);
    _gpsWatchId = null;
  }

  _aplicarEstadoGPS('BUSCANDO');
  _gpsWatchId = navigator.geolocation.watchPosition(
    _onPosicion,
    _onErrorGPS,
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

/* ── Verificar ubicación puntual antes de marcar ── */
function verificarGPSAhora() {
  return new Promise(resolve => {
    if (!navigator.geolocation) { _aplicarEstadoGPS('NO_DISPONIBLE'); resolve(); return; }
    navigator.geolocation.getCurrentPosition(
      pos => { _onPosicion(pos); resolve(); },
      err  => { _onErrorGPS(err); resolve(); },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 15000 }
    );
  });
}

/* ── Internet ── */
function _actualizarInternet() {
  const el = document.getElementById('stInternet');
  if (!el) return;
  if (navigator.onLine) { el.textContent = 'OK';      el.className = 'st-val ok'; }
  else                  { el.textContent = 'Sin red'; el.className = 'st-val er'; }
}
window.addEventListener('online',  _actualizarInternet);
window.addEventListener('offline', _actualizarInternet);
// Inicializar desde el estado real (no desde HTML estático)
_actualizarInternet();

/* ── Arranque ── */
_iniciarWatchGPS();
