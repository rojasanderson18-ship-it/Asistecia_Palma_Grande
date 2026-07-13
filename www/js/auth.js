/* ── MÓDULO: Autenticación administrativa ── */
/*
 * PIN nunca en código fuente, LocalStorage ni texto plano.
 * Flujo: SHA-256(pin) → POST al backend → comparado contra PropertiesService.PIN_HASH.
 * Sin validación local. Sin almacenamiento de PIN, hash ni sal en el dispositivo.
 * Para configurar el PIN: ejecutar setPin('XXXX') en el editor de Google Apps Script.
 */

async function _sha256(texto) {
  const encoder = new TextEncoder();
  const data = encoder.encode(texto);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/*
 * autenticarPin(pin)
 * Devuelve { ok: boolean, error?: string }
 *   ok: true  → PIN correcto según el backend
 *   ok: false → PIN incorrecto o error; error contiene el mensaje para el usuario
 */
async function autenticarPin(pin) {
  if (!pin) return { ok: false, error: 'Ingresa el PIN' };
  if (!CONFIG.GS_URL) return { ok: false, error: 'Configura la URL del servidor en Ajustes' };
  try {
    const hash = await _sha256(String(pin));
    const r = await fetch(CONFIG.GS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ accion: 'validarPin', hash }),
    });
    if (!r.ok) return { ok: false, error: 'Error del servidor (' + r.status + ')' };
    const d = await r.json();
    if (d.ok) return { ok: true };
    if (d.error === 'PIN no configurado en servidor') return { ok: false, error: 'PIN no configurado en el servidor' };
    return { ok: false, error: 'PIN incorrecto' };
  } catch {
    return { ok: false, error: 'Sin conexión al servidor' };
  }
}
