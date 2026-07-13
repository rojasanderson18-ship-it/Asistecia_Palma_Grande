/* ── MÓDULO: Autenticación administrativa ── */
/*
 * PIN nunca en código fuente, LocalStorage ni texto plano.
 * Flujo: SHA-256(pin) → POST al backend → comparado contra PropertiesService.PIN_HASH.
 * Sin validación local. Sin almacenamiento de PIN, hash ni sal en el dispositivo.
 * Para configurar el PIN inicial: ejecutar setPin('XXXX') en Google Apps Script.
 */

async function _sha256(texto) {
  const encoder = new TextEncoder();
  const data = encoder.encode(texto);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _postGs(payload) {
  const r = await fetch(CONFIG.GS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) return { ok: false, error: 'Error del servidor (' + r.status + ')' };
  return r.json();
}

/* ── Validar PIN contra backend ── */
/* Devuelve { ok: boolean, error?: string } */
async function autenticarPin(pin) {
  if (!pin) return { ok: false, error: 'Ingresa el PIN' };
  if (!CONFIG.GS_URL) return { ok: false, error: 'Configura la URL del servidor en Ajustes' };
  try {
    const hash = await _sha256(String(pin));
    const d = await _postGs({ accion: 'validarPin', hash });
    if (d.ok) return { ok: true };
    if (d.error === 'PIN no configurado en servidor') return { ok: false, error: 'PIN no configurado en el servidor' };
    return { ok: false, error: 'PIN incorrecto' };
  } catch {
    return { ok: false, error: 'Sin conexión al servidor' };
  }
}

/* ── Cambiar PIN en backend (requiere PIN actual correcto) ── */
/* Devuelve { ok: boolean, error?: string } */
async function cambiarPin(pinActual, pinNuevo) {
  if (!pinActual || !pinNuevo) return { ok: false, error: 'Ingresa todos los campos' };
  if (!CONFIG.GS_URL) return { ok: false, error: 'Configura la URL del servidor en Ajustes' };
  try {
    const hashActual = await _sha256(String(pinActual));
    const hashNuevo  = await _sha256(String(pinNuevo));
    const d = await _postGs({ accion: 'cambiarPin', hashActual, hashNuevo });
    if (d.ok) return { ok: true };
    return { ok: false, error: d.error || 'No se pudo cambiar el PIN' };
  } catch {
    return { ok: false, error: 'Sin conexión al servidor' };
  }
}

/* ── Guardar configuración en backend (requiere PIN) ── */
/* cfg: objeto con campos empresa, fincaNombre, lat, lng, radio, entrada, salida, salidaSab, umbral */
/* Devuelve { ok: boolean, error?: string } */
async function guardarConfigBackend(pin, cfg) {
  if (!pin) return { ok: false, error: 'Ingresa el PIN actual para guardar en el servidor' };
  if (!CONFIG.GS_URL) return { ok: false, error: 'Sin URL de servidor' };
  try {
    const hash = await _sha256(String(pin));
    const d = await _postGs({ accion: 'guardarConfig', hash, config: cfg });
    if (d.ok) return { ok: true };
    return { ok: false, error: d.error || 'No se pudo guardar la configuración' };
  } catch {
    return { ok: false, error: 'Sin conexión al servidor' };
  }
}
