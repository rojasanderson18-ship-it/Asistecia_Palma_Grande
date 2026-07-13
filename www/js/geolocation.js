/* ── MÓDULO: Geolocalización ── */
let gpsOk = false;
let gpsCoords = null;

function setGeo(ok) {
  const strip = document.getElementById('geoBadge');
  const txtEl = document.getElementById('geoTxt');
  if (strip) strip.className = 'geo-strip ' + (ok ? 'ok' : 'er');
  if (txtEl) txtEl.textContent = ok ? 'Dentro del predio' : 'Fuera de geocerca';
  const stUb = document.getElementById('stUbicacion');
  const stGeo = document.getElementById('stGeocerca');
  if (stUb) { stUb.textContent = ok ? 'Dentro' : 'Fuera'; stUb.className = 'st-val ' + (ok ? 'ok' : 'er'); }
  if (stGeo) { stGeo.textContent = ok ? 'OK' : 'Fuera'; stGeo.className = 'st-val ' + (ok ? 'ok' : 'er'); }
}

function chkGps() {
  if (!navigator.geolocation) { setGeo(false); return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      gpsCoords = {lat: pos.coords.latitude, lng: pos.coords.longitude};
      const R = 6371000, tr = x => x * Math.PI / 180;
      const dLa = tr(CONFIG.FINCA.lat - pos.coords.latitude);
      const dLo = tr(CONFIG.FINCA.lng - pos.coords.longitude);
      const a = Math.sin(dLa/2)**2 + Math.cos(tr(pos.coords.latitude)) * Math.cos(tr(CONFIG.FINCA.lat)) * Math.sin(dLo/2)**2;
      const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      gpsOk = d <= CONFIG.FINCA.radioMetros;
      setGeo(gpsOk);
    },
    () => setGeo(false),
    {enableHighAccuracy: true, timeout: 8000}
  );
}

chkGps();
setInterval(chkGps, 60000);

window.addEventListener('online', () => {
  const el = document.getElementById('stInternet');
  if (el) { el.textContent = 'OK'; el.className = 'st-val ok'; }
});
window.addEventListener('offline', () => {
  const el = document.getElementById('stInternet');
  if (el) { el.textContent = 'Sin red'; el.className = 'st-val er'; }
});
