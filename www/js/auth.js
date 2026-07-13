/* ── MÓDULO: Autenticación administrativa ── */

/*
 * Estado actual: PIN validado localmente contra hash en localStorage.
 * El PIN en texto plano NUNCA se guarda — solo el hash (btoa simple, upgradar
 * a bcrypt/PBKDF2 en el backend cuando esté disponible).
 *
 * Roadmap:
 *   Fase 1 (actual) : hash local en localStorage — sin PIN en código fuente
 *   Fase 2 (próximo): validatePinRemoto() llama al endpoint GAS con hash SHA-256
 *   Fase 3 (futuro) : JWT + sesión, roles de supervisor vs. gerente
 */

// Simple hash sin librería externa: btoa(pin + salt) no es criptográfico
// pero es significativamente mejor que guardar el PIN en texto plano.
// Salt = primer día de la configuración actual (cambia si se reconfigura).
function _hashPin(pin) {
  const cfg = getCfgGuardada();
  const salt = (cfg && cfg._salt) ? cfg._salt : 'palma2024';
  return btoa(unescape(encodeURIComponent(pin + salt)));
}

function _generarSalt() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ── Validación local (Fase 1) ── */
function validatePin(pin) {
  if (!pin) return false;
  try {
    const cfg = getCfgGuardada();
    if (!cfg) return false;
    // Formato nuevo: hash almacenado
    if (cfg.pinHash) return _hashPin(pin) === cfg.pinHash;
    // Formato legacy (migración): PIN en claro — migrar al guardar
    if (cfg.pin) {
      const ok = pin === cfg.pin;
      if (ok) _migrarPinAHash(pin, cfg);
      return ok;
    }
    return false;
  } catch { return false; }
}

// Migración silenciosa: si encuentra PIN en claro, lo convierte a hash
function _migrarPinAHash(pin, cfg) {
  try {
    const salt = _generarSalt();
    const hash = btoa(unescape(encodeURIComponent(pin + salt)));
    const nueva = { ...cfg, pinHash: hash, _salt: salt };
    delete nueva.pin;
    localStorage.setItem('app_config', JSON.stringify(nueva));
  } catch {}
}

function guardarPin(pinNuevo) {
  if (!pinNuevo || !/^\d{4,8}$/.test(pinNuevo)) return false;
  const cfg = getCfgGuardada() || {};
  const salt = _generarSalt();
  const hash = btoa(unescape(encodeURIComponent(pinNuevo + salt)));
  const nueva = { ...cfg, pinHash: hash, _salt: salt };
  delete nueva.pin; // eliminar formato legado si existía
  localStorage.setItem('app_config', JSON.stringify(nueva));
  aplicarConfig(nueva);
  return true;
}

function hayPinConfigurado() {
  const cfg = getCfgGuardada();
  return !!(cfg && (cfg.pinHash || cfg.pin));
}

/* ── Stub para validación remota (Fase 2 — conectar cuando el backend esté listo) ── */
async function validatePinRemoto(pin) {
  if (!CONFIG.GS_URL) return { ok: false, error: 'Sin URL de backend' };
  try {
    const hash = _hashPin(pin);
    const r = await fetch(CONFIG.GS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ accion: 'validarPin', hash }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
