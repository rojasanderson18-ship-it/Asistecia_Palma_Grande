/* ── MÓDULO: Autenticación administrativa ── */

/*
 * El PIN NUNCA se almacena en texto plano.
 * El PIN NUNCA se almacena como hash reversible.
 * La sal NUNCA se almacena junto al hash en el mismo storage.
 *
 * Mecanismo actual (Fase 2):
 *   - El hash es SHA-256 del PIN + salt fijo derivado del dispositivo.
 *   - El salt no es secreto pero no está en localStorage: se deriva de
 *     la URL de instalación (origin) para que el hash sea específico
 *     del dispositivo/dominio y no sea transferible.
 *   - La validación definitiva ocurre en el backend (validatePinBackend).
 *   - La validación local es solo para fallback offline.
 *
 * Roadmap:
 *   Fase 2 (actual) : SHA-256 local + validación remota en GAS
 *   Fase 3 (futuro) : JWT de sesión, roles supervisor/gerente, TOTP
 */

// Salt derivado del origin (no secreto, pero específico al dominio instalado)
function _salt() {
  return (location.origin || 'app') + ':asistencia:v2';
}

async function _sha256(texto) {
  const encoder = new TextEncoder();
  const data = encoder.encode(texto);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── API pública ── */

async function guardarPin(pinNuevo) {
  if (!pinNuevo || !/^\d{4,8}$/.test(pinNuevo)) return false;
  const hash = await _sha256(pinNuevo + _salt());
  const cfg = getCfgGuardada() || {};
  // Guardar solo el hash; eliminar cualquier vestigio de PIN en claro o hash reversible
  delete cfg.pin;
  delete cfg.pinHash;
  delete cfg._salt;
  cfg.pinSha = hash;
  localStorage.setItem('app_config', JSON.stringify(cfg));
  aplicarConfig(cfg);
  return true;
}

// Validación local (fallback offline)
async function validatePin(pin) {
  if (!pin) return false;
  try {
    const cfg = getCfgGuardada();
    if (!cfg) return false;

    // Formato actual: SHA-256
    if (cfg.pinSha) {
      const hash = await _sha256(pin + _salt());
      return hash === cfg.pinSha;
    }

    // Formatos legados — migrar al guardar, no aceptar
    // (si solo hay cfg.pin o cfg.pinHash, forzar reconfiguración)
    return false;
  } catch { return false; }
}

function hayPinConfigurado() {
  const cfg = getCfgGuardada();
  return !!(cfg && cfg.pinSha);
}

/* ── Validación remota en Google Apps Script ── */
// Envía el hash SHA-256 al backend, que verifica sin conocer el PIN en claro.
// El backend almacena solo el hash del PIN configurado por el administrador.
async function validatePinBackend(pin) {
  if (!CONFIG.GS_URL) return { ok: false, offline: true };
  try {
    const hash = await _sha256(pin + _salt());
    const r = await fetch(CONFIG.GS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ accion: 'validarPin', hash }),
    });
    const d = await r.json();
    return d;
  } catch {
    return { ok: false, offline: true };
  }
}

/* ── Wrapper para uso en admin.js ── */
// Intenta validación remota primero; si no hay red, cae en local.
// Devuelve una Promise<boolean>.
async function autenticarPin(pin) {
  if (!pin) return false;

  // Intentar backend si hay URL
  if (CONFIG.GS_URL) {
    const res = await validatePinBackend(pin);
    if (!res.offline) return !!res.ok;
    // offline: continuar con validación local
  }

  // Sin red: validación local con hash SHA-256
  if (!hayPinConfigurado()) return true; // primera instalación: sin PIN aún
  return await validatePin(pin);
}
