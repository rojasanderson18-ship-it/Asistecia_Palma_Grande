/* ── MÓDULO: Admin ── */

function actualizarMenuAdmin() {
  updColaBadge();
  const rostros = getRostros();
  const meta = getRostrosMeta();
  const enrolados = getPC().filter(p => rostros[p.nombre]);
  const viejos = enrolados.filter(p => !meta[p.nombre] || meta[p.nombre].v < 2);
  const sub = document.getElementById('menuRostrosSub');
  if (sub) sub.textContent = `${enrolados.length} de ${getPC().length} enrolados`;
  const avisoEl = document.getElementById('avisoReenrolar');
  const avisoTxt = document.getElementById('avisoReenrolarTxt');
  if (avisoEl && avisoTxt) {
    if (viejos.length) { avisoEl.style.display = 'block'; avisoTxt.textContent = `${viejos.length} empleado(s) con enrolamiento antiguo (1 captura).`; }
    else { avisoEl.style.display = 'none'; }
  }
  const cola = JSON.parse(localStorage.getItem('cola') || '[]');
  const dashCola = document.getElementById('dashColaCnt');
  if (dashCola) {
    if (cola.length) { dashCola.textContent = cola.length; dashCola.style.display = ''; }
    else { dashCola.style.display = 'none'; }
  }
}

/* ── PIN screen ── */
let _pinDest = 'menu';

function abrirPinScreen(dest) {
  _pinDest = dest || 'menu';
  const pinInput = document.getElementById('pinInput');
  if (pinInput) pinInput.value = '';
  // Si había un escaneo de asistencia en curso, detenerlo del todo (cámara +
  // estado) antes de entrar a modo admin — si no, sigue corriendo en segundo
  // plano y compite por la cámara con un enrolamiento que se inicie después.
  if (typeof resetDocumentoInicio === 'function') resetDocumentoInicio();
  mostrarPantalla('pantallaPin');
}

document.getElementById('btnPinCancelar').onclick = () => mostrarPantalla('pantallaMarcacion');
document.getElementById('btnPinConfirmar').onclick = async () => {
  const btn = document.getElementById('btnPinConfirmar');
  const val = document.getElementById('pinInput').value;
  const errEl = document.getElementById('pinErr');
  btn.disabled = true;
  btn.classList.add('btn-loading');
  const result = await login(val);
  btn.disabled = false;
  btn.classList.remove('btn-loading');
  if (result.ok) {
    cargarPersonalDesdeBackend();
    if (_pinDest === 'setup') {
      _ejecutarSetup();
    } else if (_pinDest === 'enrolar') {
      _abrirEnrolar();
    } else if (_pinDest === 'agregar') {
      _abrirAgregarPersonal();
    } else {
      mostrarPantalla('pantallaMenu');
    }
  } else {
    if (errEl) { errEl.textContent = result.error || 'PIN incorrecto'; errEl.style.display = 'block'; setTimeout(() => { errEl.textContent = ''; errEl.style.display = 'none'; }, 3000); }
  }
};
document.getElementById('pinInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnPinConfirmar').click();
});

/* ── Menú admin ── */
document.getElementById('menuCerrar').onclick = () => mostrarPantalla('pantallaMarcacion');

document.getElementById('menuEnrolar').onclick = () => {
  pintarGrilla('grillaEnrolar', nombre => {
    nombreEnrolando = nombre; modoActual = 'enrolar'; errE = 0;
    mostrarPantalla('pantallaMarcacion');
    procesarEnrolar();
  });
  mostrarPantalla('pantallaEnrolar');
};

document.getElementById('menuAgregar').onclick = () => {
  _abrirAgregarPersonal();
};

document.getElementById('menuReporte').onclick = () => {
  const hoy = new Date();
  const repFecha = document.getElementById('repFecha');
  if (repFecha) repFecha.value = fechaLocalISO();
  mostrarPantalla('pantallaReporte');
  cargarReporte();
};

document.getElementById('menuConfig').onclick = () => abrirConfig();

document.getElementById('menuDispositivos').onclick = () => {
  abrirConfig();
  const sec = document.getElementById('dispositivoInfo');
  if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

document.getElementById('menuColaPendientes').onclick = () => {
  const cola = JSON.parse(localStorage.getItem('cola') || '[]');
  if (!cola.length) { showToast('No hay marcaciones pendientes de sincronizar'); return; }
  showToast(`${cola.length} marcación(es) pendientes de enviar`);
};

document.getElementById('menuGeocerca').onclick = () => abrirConfig();

const _btnSeguridad = document.getElementById('menuSeguridad');
if (_btnSeguridad) _btnSeguridad.onclick = () => {
  abrirPinScreen('menu');
};

/* ── Enrolar ── */
function _abrirEnrolar() {
  pintarGrilla('grillaEnrolar', nombre => {
    nombreEnrolando = nombre; modoActual = 'enrolar'; errE = 0;
    mostrarPantalla('pantallaMarcacion');
    procesarEnrolar();
  });
  mostrarPantalla('pantallaEnrolar');
}
document.getElementById('btnVolverMarcacion').onclick = () => { modoActual = null; mostrarPantalla('pantallaMenu'); };

/* ── Agregar personal ── */
function _abrirAgregarPersonal() {
  document.getElementById('nuevoDocumento').value = '';
  document.getElementById('nuevoNombre').value = '';
  document.getElementById('nuevoCargo').value = '';
  mostrarPantalla('pantallaAgregar');
}
document.getElementById('btnCancelarAgregar').onclick = () => mostrarPantalla('pantallaMenu');
document.getElementById('btnCancelarAgregar2').onclick = () => mostrarPantalla('pantallaMenu');
document.getElementById('btnGuardarPersonal').onclick = async () => {
  const doc = document.getElementById('nuevoDocumento').value.trim();
  const nom = document.getElementById('nuevoNombre').value.trim();
  const car = document.getElementById('nuevoCargo').value;
  if (!doc) { await showAlert('Escribe el documento'); return; }
  if (!/^\d+$/.test(doc)) { await showAlert('Solo números — sin letras ni espacios'); return; }
  if (!nom) { await showAlert('Escribe el nombre'); return; }
  if (!car) { await showAlert('Selecciona un cargo'); return; }
  if (getPC().some(p => p.nombre.toLowerCase() === nom.toLowerCase())) { await showAlert('Ya existe un trabajador con ese nombre'); return; }
  if (getPorDoc(doc)) { await showAlert('Ya existe un trabajador con ese documento'); return; }
  const btn = document.getElementById('btnGuardarPersonal'); btn.disabled = true;
  const r = await enviarConResp({accion:'registrarPersonal', token:getAdminToken(), documento:doc, nombre:nom, cargo:car, fechaHora:new Date().toISOString()});
  btn.disabled = false;
  if (!r || !r.ok) { showRes('err', 'No se pudo registrar', `<b>${xh(nom)}</b> no se guardó en el servidor.<br><small>${xh((r && r.error) || 'Sin conexión')}</small>`, []); return; }
  const ex = getPE(); ex.push({documento:doc, nombre:nom, cargo:car}); savePE(ex);
  showRes('ok', 'Personal agregado', `<b>${xh(nom)}</b><br>${xh(car)} · Doc. ${xh(doc)}`, []);
  setTimeout(() => mostrarPantalla('pantallaMarcacion'), 2200);
};

/* ── Gestión de rostros ── */
function abrirGestionRostros() {
  const rostros = getRostros(), meta = getRostrosMeta(), todos = getPC();
  const enrolados = todos.filter(p => rostros[p.nombre]);
  const viejos = enrolados.filter(p => !meta[p.nombre] || meta[p.nombre].v < 2);
  const countEl = document.getElementById('rostrosCount');
  if (countEl) countEl.textContent = enrolados.length;
  const sub = document.getElementById('menuRostrosSub');
  if (sub) sub.textContent = `${enrolados.length} de ${todos.length} enrolados`;
  const avisoEl = document.getElementById('avisoReenrolar');
  const avisoTxt = document.getElementById('avisoReenrolarTxt');
  if (avisoEl && avisoTxt) {
    if (viejos.length) { avisoEl.style.display = 'block'; avisoTxt.textContent = `${viejos.length} empleado(s) enrolado(s) con el sistema antiguo (1 sola captura).`; }
    else { avisoEl.style.display = 'none'; }
  }
  const lista = document.getElementById('listaRostros');
  if (!lista) return;
  lista.innerHTML = '';
  todos.forEach(p => {
    const enrol = !!rostros[p.nombre];
    const esViejo = enrol && (!meta[p.nombre] || meta[p.nombre].v < 2);
    const fechaStr = meta[p.nombre] ? new Date(meta[p.nombre].fecha).toLocaleDateString('es-CO', {day:'2-digit', month:'2-digit', year:'numeric'}) : '';
    const div = document.createElement('div');
    div.style.cssText = 'background:var(--wh);border:1px solid var(--bd);border-radius:12px;padding:12px 14px;display:flex;align-items:center;gap:12px;';
    div.innerHTML = `
      <div style="width:36px;height:36px;border-radius:50%;background:${enrol?'var(--xl)':'var(--bg)'};border:1.5px solid ${enrol?'var(--dg)':'var(--bd)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <span style="font-size:11px;font-weight:700;color:${enrol?'var(--dg)':'var(--t2)'}">${inic(p.nombre)}</span>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${xh(p.nombre)}</div>
        <div style="font-size:11px;color:var(--t2);margin-top:2px;">${enrol ? (esViejo ? '⚠️ Enrolado (antiguo)' : '✓ Enrolado · ' + fechaStr) : 'Sin enrolar'}</div>
      </div>
      ${enrol ? `<button data-nombre="${encodeURIComponent(p.nombre)}" style="background:var(--rl);border:1px solid #FFCDD2;color:var(--re);border-radius:7px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;flex-shrink:0;">Borrar</button>` : ''}
    `;
    lista.appendChild(div);
  });
  lista.onclick = async e => {
    const btn = e.target.closest('button[data-nombre]'); if (!btn) return;
    const nombre = decodeURIComponent(btn.dataset.nombre);
    if (!await showConfirm(`¿Borrar el rostro de ${nombre}?\nDeberá enrolarse nuevamente.`, 'Borrar', true)) return;
    deleteRostro(nombre); showToast('Rostro eliminado'); abrirGestionRostros();
  };
  mostrarPantalla('pantallaRostros');
}
document.getElementById('menuRostros').onclick = abrirGestionRostros;
document.getElementById('btnVolverDesdeRostros').onclick = () => mostrarPantalla('pantallaMenu');
document.getElementById('btnBorrarTodosRostros').onclick = async () => {
  const n = Object.keys(getRostros()).length;
  if (!n) { showToast('No hay rostros enrolados'); return; }
  if (!await showConfirm(`¿Borrar los ${n} rostros enrolados?\nTodos deberán enrolarse nuevamente.`, 'Borrar todo', true)) return;
  localStorage.removeItem('rostros_enrolados');
  localStorage.removeItem('rostros_meta');
  showToast('Todos los rostros eliminados');
  abrirGestionRostros();
};

/* ── Respaldo cifrado de enrolamientos (AES-GCM, Web Crypto nativo) ──
   Los rostros solo viven en localStorage; si se borra la app se pierden.
   Esto permite exportar/importar un archivo cifrado con contraseña propia
   (distinta del PIN admin) para restaurarlos en otro dispositivo. ── */
async function _derivarClaveRespaldo(password, salt) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
function _bufAB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function _b64ABuf(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }

document.getElementById('btnRespaldarRostros').onclick = async () => {
  const rostros = getRostros();
  const n = Object.keys(rostros).length;
  if (!n) { showToast('No hay rostros enrolados para respaldar'); return; }

  const pass1 = await askPassword(`Crea una contraseña para cifrar el respaldo de ${n} rostro(s).\nGuárdala bien — sin ella no se podrá restaurar.`, 'Continuar');
  if (!pass1) return;
  if (pass1.length < 6) { await showAlert('Usa una contraseña de al menos 6 caracteres.'); return; }
  const pass2 = await askPassword('Repite la contraseña para confirmar.', 'Confirmar');
  if (pass2 !== pass1) { await showAlert('Las contraseñas no coinciden. Intenta de nuevo.'); return; }

  try {
    const datos = { rostros, meta: getRostrosMeta() };
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const key  = await _derivarClaveRespaldo(pass1, salt);
    const enc  = new TextEncoder();
    const cifrado = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(datos)));
    const payload = { v: 1, salt: _bufAB64(salt), iv: _bufAB64(iv), data: _bufAB64(cifrado) };

    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `respaldo_rostros_${fechaLocalISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`✓ Respaldo de ${n} rostro(s) descargado`);
  } catch (e) {
    await showAlert('No se pudo generar el respaldo: ' + (e.message || 'error desconocido'));
  }
};

document.getElementById('btnRestaurarRostros').onclick = () => {
  document.getElementById('inputRestaurarRostros').click();
};
document.getElementById('inputRestaurarRostros').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
    if (!payload || payload.v !== 1 || !payload.salt || !payload.iv || !payload.data) throw new Error('formato');
  } catch {
    await showAlert('Ese archivo no es un respaldo de rostros válido.');
    return;
  }

  const pass = await askPassword('Contraseña del respaldo:', 'Restaurar');
  if (!pass) return;

  try {
    const salt = _b64ABuf(payload.salt);
    const iv   = _b64ABuf(payload.iv);
    const key  = await _derivarClaveRespaldo(pass, salt);
    const plano = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, _b64ABuf(payload.data));
    const datos = JSON.parse(new TextDecoder().decode(plano));

    const actuales = getRostros();
    const n = Object.keys(datos.rostros || {}).length;
    if (!await showConfirm(`Se restaurarán ${n} rostro(s). Los que ya existan en este dispositivo con el mismo nombre se sobrescribirán. ¿Continuar?`, 'Restaurar', true)) return;

    const rostrosFusionados = { ...actuales, ...(datos.rostros || {}) };
    const metaFusionada = { ...getRostrosMeta(), ...(datos.meta || {}) };
    localStorage.setItem('rostros_enrolados', JSON.stringify(rostrosFusionados));
    localStorage.setItem('rostros_meta', JSON.stringify(metaFusionada));
    showToast(`✓ ${n} rostro(s) restaurado(s)`);
    abrirGestionRostros();
  } catch (e) {
    // AES-GCM falla su verificación de integridad si la contraseña es incorrecta
    await showAlert('No se pudo restaurar — la contraseña es incorrecta o el archivo está dañado.');
  }
});

/* ── Configuración ── */

/* ── Tabla de horarios (7 días) ── */
function _renderHorTabla(horarios) {
  const body = document.getElementById('horTablaBody');
  if (!body) return;
  body.innerHTML = '';
  horarios.forEach(function(h) {
    const row = document.createElement('div');
    row.className = 'hor-row' + (h.activo ? '' : ' hor-row-off');
    row.dataset.dia = h.dia;
    row.innerHTML = `
      <span class="hor-dia">${h.nombre.slice(0,3)}</span>
      <span><label class="hor-toggle"><input type="checkbox" class="hor-activo" ${h.activo ? 'checked' : ''}><span class="hor-track"></span></label></span>
      <span><input type="time" class="hor-time hor-entrada" value="${h.entrada || ''}" ${!h.activo ? 'disabled' : ''}></span>
      <span><input type="time" class="hor-time hor-salida" value="${h.salida || ''}" ${!h.activo ? 'disabled' : ''}></span>
      <span><input type="number" class="hor-tol" value="${h.tolEntrada ?? 10}" min="0" max="60" ${!h.activo ? 'disabled' : ''}></span>
      <span><input type="number" class="hor-tol" value="${h.tolSalida ?? 5}" min="0" max="60" ${!h.activo ? 'disabled' : ''}></span>
    `;
    row.querySelector('.hor-activo').addEventListener('change', function() {
      const on = this.checked;
      row.classList.toggle('hor-row-off', !on);
      row.querySelectorAll('input:not(.hor-activo)').forEach(function(i) { i.disabled = !on; });
    });
    body.appendChild(row);
  });
}

function _leerHorTabla() {
  const rows = document.querySelectorAll('#horTablaBody .hor-row');
  return Array.from(rows).map(function(row) {
    const inputs = row.querySelectorAll('input');
    const activo = inputs[0].checked;
    return {
      dia:        parseInt(row.dataset.dia),
      nombre:     CONFIG.HORARIOS.find(function(h) { return h.dia === parseInt(row.dataset.dia); })?.nombre || '',
      activo:     activo,
      entrada:    activo ? inputs[1].value : '',
      salida:     activo ? inputs[2].value : '',
      tolEntrada: activo ? parseInt(inputs[3].value) || 0 : 0,
      tolSalida:  activo ? parseInt(inputs[4].value) || 0 : 0,
    };
  });
}

function abrirConfig() {
  const cfg = getCfgGuardada() || {};
  const gsUrlEl = document.getElementById('cfgGsUrl');
  if (gsUrlEl) gsUrlEl.value = cfg.gsUrl || '';
  const empresaEl = document.getElementById('cfgEmpresa');
  if (empresaEl) empresaEl.value = cfg.empresa || CONFIG.EMPRESA.nombre;
  document.getElementById('cfgNombreFinca').value = cfg.fincaNombre || CONFIG.FINCA.nombre;
  document.getElementById('cfgLat').value = cfg.lat != null ? cfg.lat : '';
  document.getElementById('cfgLng').value = cfg.lng != null ? cfg.lng : '';
  document.getElementById('cfgRadio').value = cfg.radio != null ? cfg.radio : CONFIG.FINCA.radioMetros;
  // Tabla de horarios
  const horarios = (cfg.horarios && Array.isArray(cfg.horarios)) ? cfg.horarios : CONFIG.HORARIOS;
  _renderHorTabla(horarios);
  const u = cfg.umbral != null ? cfg.umbral : CONFIG.UMBRAL_FACIAL;
  document.getElementById('cfgUmbral').value = u;
  document.getElementById('cfgUmbralVal').textContent = parseFloat(u).toFixed(2);
  document.getElementById('cfgPinActual').value = '';
  document.getElementById('cfgPinNuevo').value = '';
  document.getElementById('cfgPinConf').value = '';
  const infoEl = document.getElementById('dispositivoInfo');
  if (infoEl) {
    const tok = (typeof getDeviceToken === 'function') ? getDeviceToken() : null;
    infoEl.textContent = tok ? '✓ Este dispositivo ya está autorizado' : 'Sin autorizar — usa el botón para autorizar';
  }
  _cargarListaDispositivos();
  mostrarPantalla('pantallaConfig');
}

async function _cargarListaDispositivos() {
  const cont = document.getElementById('listaDispositivos');
  if (!cont) return;
  cont.innerHTML = '<div style="font-size:11.5px;color:var(--t2);">Cargando…</div>';
  const r = await listarDispositivos();
  if (!r.ok) { cont.innerHTML = `<div style="font-size:11.5px;color:var(--re);">${xh(r.error || 'No se pudo cargar la lista')}</div>`; return; }
  const esteId = (typeof _getDeviceId === 'function') ? _getDeviceId() : null;
  const activos = r.dispositivos.filter(d => d.estado === 'activo');
  if (!activos.length) { cont.innerHTML = '<div style="font-size:11.5px;color:var(--t2);">Ningún dispositivo autorizado todavía.</div>'; return; }
  cont.innerHTML = activos.map(d => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--bg);border:1px solid var(--bd);border-radius:9px;padding:9px 12px;">
      <div style="min-width:0;">
        <div style="font-size:12px;font-weight:700;">${xh(d.nombre || 'Kiosco')}${d.deviceId === esteId ? ' <span style="color:var(--dg);">(este)</span>' : ''}</div>
        <div style="font-size:10.5px;color:var(--t2);margin-top:1px;">Autorizado: ${xh(d.fechaRegistro || '—')}</div>
      </div>
      <button data-device-id="${xh(d.deviceId)}" class="btn-revocar-disp" style="flex-shrink:0;background:var(--rl);border:1px solid #FFCDD2;color:var(--re);border-radius:7px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;">Revocar</button>
    </div>
  `).join('');
  cont.querySelectorAll('.btn-revocar-disp').forEach(btn => {
    btn.onclick = async () => {
      const deviceId = btn.dataset.deviceId;
      const ok = await showConfirm('¿Revocar el acceso de este dispositivo? Dejará de poder registrar asistencia hasta autorizarlo de nuevo.');
      if (!ok) return;
      btn.disabled = true; btn.textContent = 'Revocando…';
      const r2 = await revocarDispositivo(deviceId);
      if (r2.ok) { showToast('✓ Dispositivo revocado'); _cargarListaDispositivos(); }
      else { showToast('Error: ' + (r2.error || 'No se pudo revocar')); btn.disabled = false; btn.textContent = 'Revocar'; }
    };
  });
}

document.getElementById('cfgUmbral').addEventListener('input', function() {
  const v = parseFloat(this.value);
  document.getElementById('cfgUmbralVal').textContent = v.toFixed(2);
  const adv = document.getElementById('umbralAdvertencia');
  if (adv) adv.style.display = v > 0.55 ? '' : 'none';
});
document.getElementById('btnUsarUbicacion').addEventListener('click', async () => {
  if (!navigator.geolocation) { await showAlert('GPS no disponible en este dispositivo'); return; }
  const btn = document.getElementById('btnUsarUbicacion');
  btn.textContent = 'Obteniendo ubicación…'; btn.disabled = true;
  navigator.geolocation.getCurrentPosition(pos => {
    document.getElementById('cfgLat').value = pos.coords.latitude.toFixed(6);
    document.getElementById('cfgLng').value = pos.coords.longitude.toFixed(6);
    btn.textContent = '✓ Ubicación capturada'; btn.disabled = false;
  }, async () => {
    btn.textContent = 'Usar mi ubicación actual'; btn.disabled = false;
    await showAlert('No se pudo obtener la ubicación.\nVerifique los permisos de GPS.');
  }, { enableHighAccuracy: true, timeout: 8000 });
});
/* ── Autorizar dispositivo ── */
document.getElementById('btnAutorizarDispositivo').addEventListener('click', async () => {
  const btn = document.getElementById('btnAutorizarDispositivo');
  const infoEl = document.getElementById('dispositivoInfo');
  btn.disabled = true;
  const r = await autorizarDispositivo('Kiosco');
  btn.disabled = false;
  if (r.ok) {
    if (infoEl) infoEl.textContent = r.nuevo ? '✓ Dispositivo autorizado correctamente' : '✓ Dispositivo ya estaba autorizado (token actualizado)';
    showToast('✓ Dispositivo autorizado');
    _cargarListaDispositivos();
  } else {
    if (infoEl) infoEl.textContent = '✗ ' + (r.error || 'Error al autorizar');
    showToast('Error: ' + (r.error || 'No se pudo autorizar'));
  }
});

document.getElementById('btnGuardarConfig').addEventListener('click', async () => {
  const pinActual = document.getElementById('cfgPinActual').value;
  const pinNuevo  = document.getElementById('cfgPinNuevo').value;
  const pinConf   = document.getElementById('cfgPinConf').value;

  if (pinNuevo) {
    if (!/^\d{4,8}$/.test(pinNuevo)) { await showAlert('El PIN nuevo debe tener entre 4 y 8 dígitos'); return; }
    if (pinNuevo !== pinConf) { await showAlert('Los PINs nuevos no coinciden'); return; }
    if (!pinActual) { await showAlert('Ingresa el PIN actual para cambiar el PIN'); return; }
  }

  const gsUrlVal    = (document.getElementById('cfgGsUrl') || {}).value || '';
  const empresaVal  = (document.getElementById('cfgEmpresa') || {}).value || '';
  const fincaNombre = document.getElementById('cfgNombreFinca').value.trim();
  const lat         = parseFloat(document.getElementById('cfgLat').value);
  const lng         = parseFloat(document.getElementById('cfgLng').value);
  const radio       = parseInt(document.getElementById('cfgRadio').value);
  const umbral      = parseFloat(document.getElementById('cfgUmbral').value);
  const horarios    = _leerHorTabla();

  if (!fincaNombre) { await showAlert('Escribe el nombre de la finca'); return; }
  if (isNaN(lat) || isNaN(lng)) { await showAlert('Las coordenadas no son válidas'); return; }
  if (isNaN(radio) || radio < 50) { await showAlert('El radio mínimo es 50 metros'); return; }

  const btn = document.getElementById('btnGuardarConfig');
  btn.disabled = true;

  // 1. Cambiar PIN en backend si se solicitó
  if (pinNuevo && pinActual) {
    const r = await cambiarPin(pinActual, pinNuevo);
    if (!r.ok) { btn.disabled = false; await showAlert('No se pudo cambiar el PIN:\n' + r.error); return; }
    showToast('✓ PIN actualizado en el servidor');
  }

  const prev = getCfgGuardada() || {};
  const cfg = {
    ...prev,
    gsUrl: gsUrlVal.trim() || prev.gsUrl || '',
    empresa: empresaVal.trim() || prev.empresa || '',
    fincaNombre, lat, lng, radio, umbral, horarios,
  };
  delete cfg.pin; delete cfg.pinHash; delete cfg.pinSha; delete cfg._salt; delete cfg.nombreFinca;
  delete cfg.entrada; delete cfg.salida; delete cfg.salidaSab;

  // 2. Si hay URL de servidor: guardar PRIMERO en backend; solo guardar local si el backend acepta
  if (CONFIG.GS_URL || cfg.gsUrl) {
    if (cfg.gsUrl && !CONFIG.GS_URL) CONFIG.GS_URL = cfg.gsUrl;
    const cfgBackend = { empresa: cfg.empresa, fincaNombre, lat, lng, radio, umbral, horarios };
    const rb = await guardarConfigBackend(cfgBackend);
    if (!rb.ok) {
      btn.disabled = false;
      await showAlert('Cambio no aplicado: no fue posible validar con el servidor.\n' + (rb.error || ''));
      return;
    }
  }

  // 3. Backend aceptó (o no hay URL de servidor): guardar en LocalStorage
  localStorage.setItem('app_config', JSON.stringify(cfg));
  aplicarConfig(cfg);

  btn.disabled = false;
  aplicarEmpresaUI();
  mostrarPantalla('pantallaMenu');
  showToast('✓ Configuración guardada');
  setTimeout(() => { sincronizarConfigDesdeBackend(); cargarPersonalDesdeBackend(); }, 500);
});
document.getElementById('btnVolverDesdeConfig').addEventListener('click', () => mostrarPantalla('pantallaMenu'));
document.getElementById('btnCancelarConfig').addEventListener('click', () => mostrarPantalla('pantallaMenu'));

/* ── Menú personal (unificado) ── */
document.getElementById('menuPersonal').onclick = abrirPersonal;

/* ── Resetear día ── */
document.getElementById('menuResetDia').onclick = abrirResetDia;
document.getElementById('btnVolverDesdeResetDia').onclick = () => mostrarPantalla('pantallaMenu');

function abrirResetDia() {
  mostrarPantalla('pantallaResetDia');
  _renderResetDia();
}

function _renderResetDia() {
  const lista  = document.getElementById('resetDiaLista');
  const vacio  = document.getElementById('resetDiaVacio');
  const hoy    = (typeof fechaLocalISO === 'function') ? fechaLocalISO() : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const cache  = JSON.parse(localStorage.getItem('marcas_hoy_cache') || '{}');
  const cola   = JSON.parse(localStorage.getItem('cola') || '[]');

  // Personas con registros hoy en caché
  const personas = Object.entries(cache)
    .filter(([k]) => k !== '_fecha' && cache._fecha === hoy)
    .map(([doc, marcas]) => {
      const persona = (typeof getPorDoc === 'function') ? getPorDoc(doc) : null;
      const nombre  = persona ? persona.nombre : doc;
      const pendCola = cola.filter(i => String(i.documento) === String(doc)).length;
      return { doc, nombre, marcas: Array.isArray(marcas) ? marcas : [], pendCola };
    });

  lista.innerHTML = '';
  if (!personas.length) {
    vacio.style.display = 'block';
    lista.style.display = 'none';
    return;
  }
  vacio.style.display = 'none';
  lista.style.display = 'flex';

  personas.forEach(({ doc, nombre, marcas, pendCola }) => {
    const item = document.createElement('div');
    item.style.cssText = 'background:var(--wh);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:12px;';
    const tags = marcas.map(m =>
      `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;background:${m==='Entrada'?'rgba(46,173,110,.12)':'rgba(239,68,68,.10)'};color:${m==='Entrada'?'var(--dg)':'var(--re)'}">${m}</span>`
    ).join('');
    const colaTag = pendCola ? `<span style="font-size:10px;color:#F59E0B;font-weight:700;">· ${pendCola} en cola</span>` : '';
    item.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${xh(nombre)}</div>
        <div style="display:flex;gap:5px;align-items:center;margin-top:5px;flex-wrap:wrap;">${tags}${colaTag}</div>
      </div>
      <button data-doc="${xh(doc)}" class="btn-reset-dia-item" style="background:var(--rl);border:1px solid #FFCDD2;color:var(--re);border-radius:8px;padding:7px 12px;font-size:11.5px;font-weight:700;cursor:pointer;flex-shrink:0;">Limpiar</button>`;
    lista.appendChild(item);
  });

  lista.querySelectorAll('.btn-reset-dia-item').forEach(btn => {
    btn.onclick = async () => {
      const doc = btn.dataset.doc;
      const persona = (typeof getPorDoc === 'function') ? getPorDoc(doc) : null;
      const nombre  = persona ? persona.nombre : doc;
      const ok = await showConfirm(
        `¿Borrar el registro de hoy de ${nombre}?\nEsto elimina su entrada/salida del caché local Y del servidor (Google Sheet). Esta acción no se puede deshacer.`,
        'Borrar', true
      );
      if (!ok) return;

      btn.disabled = true;
      btn.classList.add('btn-loading');

      // 1. Borrar en el servidor (registro real en el Sheet)
      const hoy = (typeof fechaLocalISO === 'function') ? fechaLocalISO() : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
      const r = await enviarConResp({ accion: 'borrarMarcacionesDelDia', token: getAdminToken(), documento: doc, fecha: hoy });

      btn.disabled = false;
      btn.classList.remove('btn-loading');

      if (!r || !r.ok) {
        showToast('Error: ' + ((r && r.error) || 'No se pudo borrar en el servidor'));
        return;
      }

      // 2. Limpiar caché local del día
      const c = JSON.parse(localStorage.getItem('marcas_hoy_cache') || '{}');
      delete c[doc];
      localStorage.setItem('marcas_hoy_cache', JSON.stringify(c));
      // 3. Limpiar cola offline de este documento (registros de hoy)
      const q = JSON.parse(localStorage.getItem('cola') || '[]');
      const qFiltrada = q.filter(i => String(i.documento) !== String(doc));
      localStorage.setItem('cola', JSON.stringify(qFiltrada));
      if (typeof updColaBadge === 'function') updColaBadge();
      // 4. Si la "última marcación" del kiosco era justo la de esta persona, limpiarla también.
      try {
        const ultima = JSON.parse(localStorage.getItem('ultima_marc') || 'null');
        if (ultima && ultima.nombre === nombre) localStorage.removeItem('ultima_marc');
      } catch {}
      if (typeof showUltima === 'function') showUltima();
      showToast(`Registro de ${nombre} borrado (${r.borradas || 0} fila(s) en el servidor)`);
      _renderResetDia();
    };
  });
}

/* ── Reporte de deuda ── */
document.getElementById('btnVolverDesdeReporte').onclick = () => mostrarPantalla('pantallaMenu');
document.getElementById('btnRepCargar').onclick = cargarReporte;

async function cargarReporte() {
  const fechaVal = document.getElementById('repFecha').value;
  if (!fechaVal) return;
  const estEl = document.getElementById('repEstado');
  const tabEl = document.getElementById('repTabla');
  const resEl = document.getElementById('repResumen');
  const btnCar = document.getElementById('btnRepCargar');
  estEl.style.display = 'block'; estEl.textContent = 'Cargando...';
  tabEl.innerHTML = ''; resEl.style.display = 'none';
  if (btnCar) btnCar.classList.add('loading');
  if (!CONFIG.GS_URL || CONFIG.GS_URL.includes('PEGAR')) {
    estEl.textContent = '⚠️ Configura la URL del servidor primero.'; return;
  }
  let datos = [];
  try {
    const j = await enviarConResp({ accion: 'resumenDashboard', token: getAdminToken(),
                                     fecha: fechaVal, finca: CONFIG.FINCA.nombre });
    if (j && Array.isArray(j.filas)) datos = j.filas;
  } catch {}
  if (btnCar) btnCar.classList.remove('loading');
  if (!datos.length) {
    const cola = JSON.parse(localStorage.getItem('cola') || '[]');
    const marcasFecha = cola.filter(m => m.fechaLocal ? m.fechaLocal === fechaVal : (m.fechaHora && m.fechaHora.startsWith(fechaVal)));
    // Los ítems de cola se agrupan por documento (nombre no existe en el payload)
    const porDoc = {};
    marcasFecha.forEach(m => {
      const doc = String(m.documento || '');
      if (!doc) return;
      if (!porDoc[doc]) {
        const persona = getPorDoc(doc);
        porDoc[doc] = { documento: doc, nombre: persona ? persona.nombre : doc, cargo: persona ? persona.cargo : '', marcas: [], minutosDeuda: 0, puntualidad: [] };
      }
      if (m.tipo && !porDoc[doc].marcas.includes(m.tipo)) porDoc[doc].marcas.push(m.tipo);
      if (m.minutosDeuda) porDoc[doc].minutosDeuda += m.minutosDeuda;
      if (m.puntualidad && m.puntualidad !== 'ok') porDoc[doc].puntualidad.push({ tipo: m.tipo, estado: m.puntualidad, minutos: m.minutosDeuda || 0 });
    });
    datos = Object.values(porDoc);
    if (!datos.length) { estEl.textContent = 'No hay datos offline para esta fecha.'; return; }
  }
  estEl.style.display = 'none'; resEl.style.display = 'block';
  let totalTarde = 0, totalTemprano = 0, totalMin = 0, totalPresentes = 0, totalCompletas = 0, totalExcepciones = 0;
  const colaPendientes = JSON.parse(localStorage.getItem('cola') || '[]').length;
  datos.forEach(e => {
    const p = e.puntualidad || [];
    const marcas = e.marcas || [];
    p.forEach(x => { if (x.estado === 'tarde') totalTarde++; if (x.estado === 'temprano') totalTemprano++; });
    totalMin += e.minutosDeuda || 0;
    if (marcas.length > 0) totalPresentes++;
    if (marcas.includes('Entrada') && marcas.includes('Salida')) totalCompletas++;
    if (e.excepcion || (e.minutosDeuda || 0) > 60) totalExcepciones++;
  });
  const _setKpi = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  _setKpi('repCntPresentes', totalPresentes);
  _setKpi('repCntCompletas', totalCompletas);
  _setKpi('repCntTarde', totalTarde);
  _setKpi('repCntTemprano', totalTemprano);
  _setKpi('repCntPendientes', colaPendientes);
  _setKpi('repCntExcepciones', totalExcepciones);
  _setKpi('repCntDeuda', totalMin);
  // Mini-barras KPI
  const totalEmpleados = Math.max(getPC().length, 1);
  const _setBar = (id, val, max) => {
    const fill = document.getElementById(id)?.closest('.rep-kpi')?.querySelector('.rep-kpi-bar-fill');
    if (fill) setTimeout(() => { fill.style.width = Math.min(100, (val / Math.max(max, 1)) * 100) + '%'; }, 60);
  };
  _setBar('repCntPresentes',   totalPresentes,   totalEmpleados);
  _setBar('repCntCompletas',   totalCompletas,   Math.max(totalPresentes, 1));
  _setBar('repCntTarde',       totalTarde,       Math.max(totalPresentes, 1));
  _setBar('repCntTemprano',    totalTemprano,    Math.max(totalPresentes, 1));
  _setBar('repCntPendientes',  colaPendientes,   Math.max(colaPendientes, 10));
  _setBar('repCntExcepciones', totalExcepciones, Math.max(totalPresentes, 1));
  tabEl.innerHTML = datos.map((e, idx) => {
    const tieneDeuda = (e.minutosDeuda || 0) > 0;
    const salidaTemprana = (e.puntualidad || []).find(x => x.tipo === 'Salida' && x.estado === 'temprano');
    return `<div style="background:var(--wh);border-radius:14px;padding:14px;border:1px solid var(--bd);box-shadow:var(--sh);display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="width:38px;height:38px;border-radius:50%;background:var(--xl);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:var(--dg);flex-shrink:0;">${xh(inic(e.nombre))}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${xh(e.nombre)}</div>
          <div style="font-size:11px;color:var(--t2);">${xh(e.cargo || getCargo(e.nombre) || '—')}</div>
        </div>
        ${tieneDeuda ? `<div style="background:var(--rl);color:var(--re);font-size:12px;font-weight:800;border-radius:8px;padding:4px 9px;white-space:nowrap;">−${e.minutosDeuda} min</div>` : '<div style="background:#E8F5E9;color:var(--dg);font-size:12px;font-weight:800;border-radius:8px;padding:4px 9px;">✓ Al día</div>'}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${(e.marcas||[]).map(m => `<span style="background:var(--xl);color:var(--dg);font-size:10.5px;font-weight:700;border-radius:6px;padding:3px 8px;">${xh(m)}</span>`).join('')}
        ${!(e.marcas||[]).length ? '<span style="color:var(--t2);font-size:11px;">Sin marcaciones</span>' : ''}
      </div>
      ${salidaTemprana && e.documento ? `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--bg);border-radius:10px;padding:8px 10px;">
        <span style="font-size:11px;color:var(--t2);">Salida ${salidaTemprana.minutos} min antes — ej. jornada continua sin almuerzo</span>
        <button class="btn-autorizar-salida" data-doc="${xh(e.documento)}" data-nombre="${xh(e.nombre)}" style="background:var(--dg);color:#fff;border:none;border-radius:7px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;flex-shrink:0;">Autorizar</button>
      </div>` : ''}
    </div>`;
  }).join('') || '<div style="text-align:center;color:var(--t2);font-size:13px;padding:20px 0;">Sin registros</div>';

  tabEl.querySelectorAll('.btn-autorizar-salida').forEach(btn => {
    btn.onclick = async () => {
      const doc = btn.dataset.doc, nombre = btn.dataset.nombre;
      const fechaVal = document.getElementById('repFecha').value;
      if (!await showConfirm(`¿Autorizar la salida anticipada de ${nombre} ese día?\nDejará de contar como deuda de tiempo.`, 'Autorizar', false)) return;
      btn.disabled = true; btn.textContent = 'Autorizando…';
      const r = await enviarConResp({ accion: 'autorizarSalidaAnticipada', token: getAdminToken(), documento: doc, fecha: fechaVal });
      if (!r || !r.ok) { showToast('Error: ' + ((r && r.error) || 'No se pudo autorizar')); btn.disabled = false; btn.textContent = 'Autorizar'; return; }
      showToast(`✓ Salida anticipada de ${nombre} autorizada`);
      cargarReporte();
    };
  });
}

/* ══════════════════════════════════════════
   MÓDULO: GESTIÓN DE PERSONAL
══════════════════════════════════════════ */

let _persNombreActual = null;
let _persFormModo = 'crear';
let _importDatos = [];

// Actualiza los campos dados (ej. {cargo, activo}) de una persona en el
// caché local correspondiente — el sincronizado del backend (personal_cache)
// si ya vive ahí, o el local (personal_extra) si todavía no se ha sincronizado.
// Así el cambio se ve de inmediato sin esperar a la próxima sincronización.
function _actualizarPersonaLocal(nombre, cambios) {
  const cache = getPersonalCache();
  const idxCache = cache.findIndex(t => t.nombre === nombre);
  if (idxCache >= 0) {
    Object.assign(cache[idxCache], cambios);
    savePersonalCache(cache);
    return;
  }
  const extra = getPE();
  const idxExtra = extra.findIndex(t => t.nombre === nombre);
  if (idxExtra >= 0) {
    Object.assign(extra[idxExtra], cambios);
    savePE(extra);
  }
}

/* ── Listado ── */
function abrirPersonal() {
  renderPersonalList();
  mostrarPantalla('pantallaPersonal');
}

function renderPersonalList() {
  const query = (document.getElementById('persSearch')?.value || '').toLowerCase();
  const filtroEstado = document.getElementById('persFiltroEstado')?.value || '';
  const filtroRostro = document.getElementById('persFiltroRostro')?.value || '';
  const todos = getPC();
  const rostros = getRostros();
  const activos   = todos.filter(p => p.activo !== false);
  const inactivos = todos.filter(p => p.activo === false);
  const enrolados = todos.filter(p => rostros[p.nombre]);
  const sinRostro = activos.filter(p => !rostros[p.nombre]);
  const kpiEl = document.getElementById('persKpiRow');
  if (kpiEl) kpiEl.innerHTML = `
    <div class="pers-kpi"><div class="pers-kpi-val ok">${activos.length}</div><div class="pers-kpi-lbl">Activos</div></div>
    <div class="pers-kpi"><div class="pers-kpi-val muted">${inactivos.length}</div><div class="pers-kpi-lbl">Inactivos</div></div>
    <div class="pers-kpi"><div class="pers-kpi-val ok">${enrolados.length}</div><div class="pers-kpi-lbl">Enrolados</div></div>
    <div class="pers-kpi"><div class="pers-kpi-val warn">${sinRostro.length}</div><div class="pers-kpi-lbl">Sin rostro</div></div>
  `;
  let lista = todos.filter(p => {
    if (query) {
      if (!(p.nombre||'').toLowerCase().includes(query) && !(p.documento||'').includes(query)) return false;
    }
    if (filtroEstado === 'activo'   && p.activo === false) return false;
    if (filtroEstado === 'inactivo' && p.activo !== false) return false;
    if (filtroRostro === 'enrolado'   && !rostros[p.nombre]) return false;
    if (filtroRostro === 'sin-rostro' &&  rostros[p.nombre]) return false;
    return true;
  });
  const listaEl = document.getElementById('persLista');
  if (!listaEl) return;
  if (!lista.length) {
    // Distinguir "todavía sincronizando con el servidor" de "de verdad no hay
    // resultados" — si no, la demora normal de red se ve como un error.
    const sincronizando = !todos.length && !query && typeof _personalCargando !== 'undefined' && _personalCargando;
    listaEl.innerHTML = sincronizando
      ? '<div class="pers-empty"><span class="btn-loading" style="display:inline-block;width:16px;height:16px;border-radius:50%;position:relative;margin-right:6px;vertical-align:-3px;"></span>Cargando personal…</div>'
      : '<div class="pers-empty">No hay trabajadores que coincidan</div>';
    return;
  }
  listaEl.innerHTML = lista.map(p => {
    const enrol  = !!rostros[p.nombre];
    const activo = p.activo !== false;
    return `
      <div class="pers-row" data-nombre="${encodeURIComponent(p.nombre)}">
        <div class="pers-av" style="background:${activo ? 'var(--xl)' : 'rgba(255,255,255,0.06)'};">
          <span style="color:${activo ? 'var(--dg)' : 'var(--t2)'};">${xh(inic(p.nombre))}</span>
        </div>
        <div class="pers-info">
          <div class="pers-nombre">${xh(p.nombre)}</div>
          <div class="pers-sub">${xh(p.cargo || '—')} · <span style="font-variant-numeric:tabular-nums;">${xh(p.documento || '—')}</span></div>
        </div>
        <div class="pers-badges">
          ${enrol  ? '<span class="pers-badge bio">✓ Bio</span>' : '<span class="pers-badge sin-bio">Sin rostro</span>'}
          ${!activo ? '<span class="pers-badge inac">Inactivo</span>' : ''}
        </div>
        <div class="pers-row-actions">
          <button class="pers-act-btn" title="Editar" data-accion="editar" data-nombre="${encodeURIComponent(p.nombre)}">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="pers-act-btn ${enrol ? '' : 'pers-act-btn-green'}" title="${enrol ? 'Re-enrolar' : 'Enrolar'}" data-accion="enrolar" data-nombre="${encodeURIComponent(p.nombre)}">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
  listaEl.onclick = e => {
    const btn = e.target.closest('[data-accion]');
    if (btn) {
      e.stopPropagation();
      const nombre = decodeURIComponent(btn.dataset.nombre);
      if (btn.dataset.accion === 'editar') { _persNombreActual = nombre; abrirFormPersonal('editar'); }
      else { _persNombreActual = nombre; _iniciarEnrolDesdePersonal(nombre); }
      return;
    }
    const row = e.target.closest('.pers-row');
    if (row) { _persNombreActual = decodeURIComponent(row.dataset.nombre); abrirFichaPersonal(_persNombreActual); }
  };
}

async function _cargarFotoFicha(documento) {
  const r = await enviarConResp({ accion: 'obtenerFoto', token: getAdminToken(), documento });
  if (!r || !r.ok || !r.b64) return;
  const av = document.getElementById('fichaAv');
  if (!av) return;
  av.innerHTML = `<img src="data:${r.mimeType || 'image/jpeg'};base64,${r.b64}" style="width:100%;height:100%;object-fit:cover;">`;
}

/* ── Ficha ── */
function abrirFichaPersonal(nombre) {
  _persNombreActual = nombre;
  const p = getPC().find(t => t.nombre === nombre);
  if (!p) { showToast('Trabajador no encontrado'); return; }
  const rostros = getRostros(), meta = getRostrosMeta();
  const enrol  = !!rostros[nombre];
  const activo = p.activo !== false;
  const metaDatos = meta[nombre];
  const fechaEnrol = metaDatos ? new Date(metaDatos.fecha).toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'}) : null;
  const capturas = metaDatos?.v === 2 ? '5 capturas' : '1 captura (enrolamiento antiguo)';
  const fichaEl = document.getElementById('fichaContenido');
  if (!fichaEl) return;
  fichaEl.innerHTML = `
    <div class="ficha-hero">
      <div class="ficha-av" id="fichaAv" style="background:${activo ? 'var(--xl)' : 'rgba(255,255,255,0.08)'};overflow:hidden;">
        <span style="color:${activo ? 'var(--dg)' : 'var(--t2)'};">${xh(inic(nombre))}</span>
      </div>
      <div class="ficha-hero-info">
        <div class="ficha-hero-nombre">${xh(nombre)}</div>
        <div class="ficha-hero-cargo">${xh(p.cargo || '—')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
          <span class="pers-badge ${activo ? 'bio' : 'inac'}">${activo ? 'Activo' : 'Inactivo'}</span>
          ${enrol ? '<span class="pers-badge bio">✓ Biometría</span>' : '<span class="pers-badge sin-bio">Sin rostro</span>'}
        </div>
      </div>
    </div>
    <div class="ficha-info-grid">
      <div class="ficha-info-card">
        <div class="ficha-info-lbl">Documento</div>
        <div class="ficha-info-val" style="font-variant-numeric:tabular-nums;">${xh(p.documento || '—')}</div>
      </div>
      <div class="ficha-info-card">
        <div class="ficha-info-lbl">Cargo</div>
        <div class="ficha-info-val">${xh(p.cargo || '—')}</div>
      </div>
      <div class="ficha-info-card">
        <div class="ficha-info-lbl">Finca</div>
        <div class="ficha-info-val">${xh((getCfgGuardada()||{}).fincaNombre || CONFIG.FINCA.nombre || '—')}</div>
      </div>
      <div class="ficha-info-card">
        <div class="ficha-info-lbl">Estado</div>
        <div class="ficha-info-val" style="color:${activo ? 'var(--dg)' : 'var(--t2)'};">${activo ? 'Activo' : 'Inactivo'}</div>
      </div>
    </div>
    <div class="ficha-section">
      <div class="ficha-section-tit">Reconocimiento facial</div>
      ${enrol ? `
        <div class="ficha-bio-row ok">
          <div class="ficha-bio-ico ok"><svg viewBox="0 0 24 24" fill="none" stroke="#4ADE80" stroke-width="2.5" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div>
            <div style="font-size:13px;font-weight:700;">Biometría registrada</div>
            <div style="font-size:11px;color:var(--t2);margin-top:2px;">${fechaEnrol ? 'Enrolado el ' + fechaEnrol + ' · ' : ''}${capturas}</div>
          </div>
        </div>
        <div class="ficha-bio-actions">
          <button class="btn-sm btn-sm-green" id="fichaBtnReenrolar">Re-enrolar</button>
          <button class="btn-sm btn-sm-danger" id="fichaBtnBorrarRostro">Eliminar biometría</button>
        </div>
      ` : `
        <div class="ficha-bio-row warn">
          <div class="ficha-bio-ico warn"><svg viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" width="18" height="18"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
          <div style="font-size:13px;font-weight:600;color:var(--t1);">Sin biometría — no puede marcar asistencia</div>
        </div>
        <div class="ficha-bio-actions">
          <button class="btn-sm btn-sm-green" id="fichaBtnEnrolar">Enrolar ahora</button>
        </div>
      `}
    </div>
    <div class="ficha-danger">
      <div class="ficha-danger-tit">Zona de peligro</div>
      <div class="ficha-danger-actions">
        <button class="btn-sm btn-sm-danger" id="fichaBtnToggleActivo">${activo ? 'Inactivar trabajador' : 'Reactivar trabajador'}</button>
        <button class="btn-sm btn-sm-danger" id="fichaBtnEliminar">Eliminar trabajador</button>
      </div>
    </div>
  `;
  if (p.documento) _cargarFotoFicha(p.documento);
  const enrolBtn = fichaEl.querySelector('#fichaBtnEnrolar') || fichaEl.querySelector('#fichaBtnReenrolar');
  if (enrolBtn) enrolBtn.onclick = () => _iniciarEnrolDesdePersonal(nombre);
  const borrarRostroBtn = fichaEl.querySelector('#fichaBtnBorrarRostro');
  if (borrarRostroBtn) borrarRostroBtn.onclick = async () => {
    if (!await showConfirm(`¿Eliminar la biometría de ${nombre}?\nDeberá enrolarse nuevamente.`, 'Eliminar', true)) return;
    deleteRostro(nombre); showToast('Biometría eliminada'); abrirFichaPersonal(nombre);
  };
  fichaEl.querySelector('#fichaBtnToggleActivo').onclick = async () => {
    const nuevoEstado = !activo;
    if (!await showConfirm(`¿${nuevoEstado ? 'Reactivar' : 'Inactivar'} a ${nombre}?`, nuevoEstado ? 'Reactivar' : 'Inactivar')) return;
    const persona = getPC().find(t => t.nombre === nombre);
    const documento = persona ? persona.documento : '';
    const btn = fichaEl.querySelector('#fichaBtnToggleActivo'); btn.disabled = true;
    const r = await enviarConResp({accion: nuevoEstado ? 'activarPersonal' : 'inactivarPersonal', token:getAdminToken(), documento});
    btn.disabled = false;
    if (!r || !r.ok) { showToast('Error: ' + ((r && r.error) || 'No se pudo actualizar en el servidor')); return; }
    _actualizarPersonaLocal(nombre, { activo: nuevoEstado });
    showToast(nuevoEstado ? '✓ Trabajador reactivado' : '✓ Trabajador inactivado');
    abrirFichaPersonal(nombre);
  };
  fichaEl.querySelector('#fichaBtnEliminar').onclick = async () => {
    if (!await showConfirm(`¿Eliminar permanentemente a ${nombre}?\nEsta acción no se puede deshacer.`, 'Eliminar', true)) return;
    const delBtn = fichaEl.querySelector('#fichaBtnEliminar'); delBtn.disabled = true;
    // El backend busca por documento, no por nombre — sin esto el borrado
    // en el Sheet nunca encontraba la fila y fallaba en silencio.
    const persona = getPC().find(t => t.nombre === nombre);
    const documento = persona ? persona.documento : '';
    const r = await enviarConResp({accion:'eliminarPersonal', token:getAdminToken(), documento, nombre});
    delBtn.disabled = false;
    if (r && r.ok) {
      const ex = getPE().filter(t => t.nombre !== nombre); savePE(ex);
      // También purgar del caché sincronizado del backend — si no, sigue
      // apareciendo (ej. en "Última marcación") hasta la próxima sincronización.
      const cache = getPersonalCache().filter(t => t.nombre !== nombre); savePersonalCache(cache);
      // Si el último registro mostrado en el kiosco era de esta persona, limpiarlo.
      try {
        const ultima = JSON.parse(localStorage.getItem('ultima_marc') || 'null');
        if (ultima && ultima.nombre === nombre) localStorage.removeItem('ultima_marc');
      } catch {}
      deleteRostro(nombre); showToast('✓ Trabajador eliminado');
      if (typeof showUltima === 'function') showUltima();
      mostrarPantalla('pantallaPersonal'); renderPersonalList();
    } else { showToast('Error: ' + ((r && r.error) || 'No se pudo eliminar')); }
  };
  mostrarPantalla('pantallaFichaPersonal');
}

/* ── Formulario crear / editar ── */
function abrirFormPersonal(modo) {
  _persFormModo = modo;
  const tit = document.getElementById('formPersonalTit');
  if (tit) tit.textContent = modo === 'editar' ? 'Editar trabajador' : 'Nuevo trabajador';
  const docInput = document.getElementById('fpDocumento');
  const nomInput = document.getElementById('fpNombre');
  const carSelect = document.getElementById('fpCargo');
  const activoToggle = document.getElementById('fpActivo');
  const dupErr = document.getElementById('fpDupErr');
  if (dupErr) dupErr.style.display = 'none';
  if (modo === 'editar' && _persNombreActual) {
    const p = getPC().find(t => t.nombre === _persNombreActual);
    if (p) {
      if (docInput) { docInput.value = p.documento || ''; docInput.readOnly = true; docInput.style.opacity = '.5'; }
      if (nomInput) { nomInput.value = p.nombre || ''; nomInput.readOnly = true; nomInput.style.opacity = '.5'; }
      if (carSelect) carSelect.value = p.cargo || '';
      if (activoToggle) activoToggle.checked = p.activo !== false;
    }
  } else {
    if (docInput) { docInput.value = ''; docInput.readOnly = false; docInput.style.opacity = ''; }
    if (nomInput) { nomInput.value = ''; nomInput.readOnly = false; nomInput.style.opacity = ''; }
    if (carSelect) carSelect.value = '';
    if (activoToggle) activoToggle.checked = true;
  }
  mostrarPantalla('pantallaFormPersonal');
}

/* ── Enrolamiento desde personal ── */
function _iniciarEnrolDesdePersonal(nombre) {
  nombreEnrolando = nombre;
  modoActual = 'enrolar';
  errE = 0;
  _persNombreActual = nombre;
  mostrarPantalla('pantallaMarcacion');
  procesarEnrolar();
}

/* ── Importar personal ── */
function abrirImportarPersonal() {
  _importDatos = [];
  const prevEl = document.getElementById('importPreview');
  const btnImp = document.getElementById('btnConfirmarImport');
  const fileInput = document.getElementById('importFileInput');
  if (prevEl) prevEl.style.display = 'none';
  if (btnImp) btnImp.style.display = 'none';
  if (fileInput) fileInput.value = '';
  mostrarPantalla('pantallaImportarPersonal');
}

function _parsearCSV(texto) {
  const lineas = texto.trim().split('\n').filter(l => l.trim());
  if (!lineas.length) return [];
  const sep = lineas[0].includes(';') ? ';' : ',';
  const headers = lineas[0].split(sep).map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  const existentes = getPC();
  // Rastrear documentos/nombres ya vistos DENTRO del propio archivo, para
  // detectar filas repetidas entre sí (no solo contra lo ya registrado).
  const docsVistos = new Set();
  const nomsVistos = new Set();
  return lineas.slice(1).map((linea, idx) => {
    const cols = linea.split(sep).map(c => c.trim().replace(/^["']|["']$/g, ''));
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] || ''; });
    const doc = row['documento'] || row['cedula'] || row['id'] || '';
    const nom = row['nombre'] || row['name'] || '';
    const car = row['cargo'] || row['position'] || '';
    const errores = [];
    const nomKey = nom.toLowerCase();
    if (!doc) errores.push('Sin documento');
    else if (!/^\d+$/.test(doc)) errores.push('Doc. inválido');
    else if (existentes.find(p => p.documento === doc)) errores.push('Doc. duplicado');
    else if (docsVistos.has(doc)) errores.push('Doc. repetido en el archivo');
    if (!nom) errores.push('Sin nombre');
    else if (existentes.find(p => p.nombre.toLowerCase() === nomKey)) errores.push('Nombre duplicado');
    else if (nomsVistos.has(nomKey)) errores.push('Nombre repetido en el archivo');
    if (doc) docsVistos.add(doc);
    if (nom) nomsVistos.add(nomKey);
    return { fila: idx + 2, doc, nom, car, errores };
  });
}

function _renderImportPreview(datos) {
  const prevEl = document.getElementById('importPreview');
  const btnImp = document.getElementById('btnConfirmarImport');
  if (!prevEl) return;
  const validos = datos.filter(d => !d.errores.length);
  const conError = datos.filter(d => d.errores.length > 0);
  prevEl.innerHTML = `
    <div class="import-stats">
      <span class="import-stat ok">${validos.length} válido${validos.length !== 1 ? 's' : ''}</span>
      ${conError.length ? `<span class="import-stat err">${conError.length} con error${conError.length !== 1 ? 'es' : ''}</span>` : ''}
    </div>
    <div style="overflow-x:auto;border-radius:var(--r-md);border:1px solid var(--bd);margin-top:12px;">
      <table class="import-table">
        <thead><tr><th>Fila</th><th>Documento</th><th>Nombre</th><th>Cargo</th><th>Estado</th></tr></thead>
        <tbody>${datos.map(d => `
          <tr class="${d.errores.length ? 'import-row-err' : ''}">
            <td>${d.fila}</td>
            <td style="font-variant-numeric:tabular-nums;">${xh(d.doc||'—')}</td>
            <td>${xh(d.nom||'—')}</td>
            <td>${xh(d.car||'—')}</td>
            <td>${d.errores.length ? `<span class="import-err-tag">${xh(d.errores.join(', '))}</span>` : '<span class="import-ok-tag">✓</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  prevEl.style.display = 'block';
  _importDatos = validos;
  if (validos.length && btnImp) {
    btnImp.textContent = `Importar ${validos.length} trabajador${validos.length !== 1 ? 'es' : ''}`;
    btnImp.style.display = 'block';
  } else if (btnImp) { btnImp.style.display = 'none'; }
}

/* ── Event listeners: módulo personal ── */
document.getElementById('btnVolverDesdePersonal').addEventListener('click', () => mostrarPantalla('pantallaMenu'));
document.getElementById('persSearch').addEventListener('input', renderPersonalList);
document.getElementById('persFiltroEstado').addEventListener('change', renderPersonalList);
document.getElementById('persFiltroRostro').addEventListener('change', renderPersonalList);
document.getElementById('btnNuevoPersonal').addEventListener('click', () => { _persNombreActual = null; abrirFormPersonal('crear'); });
document.getElementById('btnImportarPersonal').addEventListener('click', abrirImportarPersonal);

document.getElementById('btnVolverDesdeFicha').addEventListener('click', () => { mostrarPantalla('pantallaPersonal'); renderPersonalList(); });
document.getElementById('btnEditarPersonal').addEventListener('click', () => { if (_persNombreActual) abrirFormPersonal('editar'); });

document.getElementById('btnVolverDesdeForm').addEventListener('click', () => {
  if (_persFormModo === 'editar' && _persNombreActual) abrirFichaPersonal(_persNombreActual);
  else mostrarPantalla('pantallaPersonal');
});
document.getElementById('btnCancelarFormPersonal').addEventListener('click', () => {
  if (_persFormModo === 'editar' && _persNombreActual) abrirFichaPersonal(_persNombreActual);
  else mostrarPantalla('pantallaPersonal');
});

document.getElementById('btnGuardarFormPersonal').addEventListener('click', async () => {
  const doc = document.getElementById('fpDocumento').value.trim();
  const nom = document.getElementById('fpNombre').value.trim();
  const car = document.getElementById('fpCargo').value;
  const activo = document.getElementById('fpActivo').checked;
  const dupErr = document.getElementById('fpDupErr');
  if (dupErr) dupErr.style.display = 'none';
  if (!doc || !/^\d+$/.test(doc)) { await showAlert('Escribe un número de documento válido (solo dígitos)'); return; }
  if (!nom) { await showAlert('Escribe el nombre completo'); return; }
  if (!car) { await showAlert('Selecciona un cargo'); return; }
  if (_persFormModo === 'crear') {
    if (getPC().some(p => p.nombre.toLowerCase() === nom.toLowerCase())) {
      if (dupErr) { dupErr.textContent = 'Ya existe un trabajador con ese nombre'; dupErr.style.display = 'block'; } return;
    }
    if (getPorDoc(doc)) {
      if (dupErr) { dupErr.textContent = 'Ya existe un trabajador con ese documento'; dupErr.style.display = 'block'; } return;
    }
  }
  const btn = document.getElementById('btnGuardarFormPersonal'); btn.disabled = true;
  if (_persFormModo === 'crear') {
    const r = await enviarConResp({accion:'registrarPersonal', token:getAdminToken(), documento:doc, nombre:nom, cargo:car, fechaHora:new Date().toISOString()});
    btn.disabled = false;
    if (!r || !r.ok) { showToast('Error: ' + ((r && r.error) || 'No se pudo guardar en el servidor')); return; }
    const ex = getPE(); ex.push({documento:doc, nombre:nom, cargo:car, activo:true}); savePE(ex);
    showToast('✓ Trabajador registrado'); _persNombreActual = nom; abrirFichaPersonal(nom);
  } else {
    // El backend identifica al trabajador por documento, no por nombre.
    const persona = getPC().find(t => t.nombre === _persNombreActual);
    const documento = persona ? persona.documento : '';
    const r = await enviarConResp({accion:'actualizarPersonal', token:getAdminToken(), documento, cargo:car, activo, fechaHora:new Date().toISOString()});
    btn.disabled = false;
    if (!r || !r.ok) { showToast('Error: ' + ((r && r.error) || 'No se pudo guardar en el servidor')); return; }
    _actualizarPersonaLocal(_persNombreActual, { cargo: car, activo });
    showToast('✓ Datos actualizados');
    abrirFichaPersonal(_persNombreActual);
  }
});

document.getElementById('btnVolverDesdeImportar').addEventListener('click', () => mostrarPantalla('pantallaPersonal'));

document.getElementById('importFileInput').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => _renderImportPreview(_parsearCSV(ev.target.result));
  reader.readAsText(file, 'UTF-8');
});

(function() {
  const drop = document.getElementById('importDrop');
  if (!drop) return;
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => _renderImportPreview(_parsearCSV(ev.target.result));
    reader.readAsText(file, 'UTF-8');
  });
})();

document.getElementById('btnDescargarPlantilla').addEventListener('click', () => {
  const csv = 'documento,nombre,cargo\n1000000001,Juan Pérez García,Operario de campo / cosechero\n1000000002,María López Ruiz,Supervisor';
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'plantilla_personal.csv';
  a.click();
});

document.getElementById('btnConfirmarImport').addEventListener('click', async () => {
  if (!_importDatos.length) return;
  const btn = document.getElementById('btnConfirmarImport');
  btn.disabled = true; btn.textContent = 'Importando…';
  let ok = 0, err = 0;
  for (const d of _importDatos) {
    const r = await enviarConResp({accion:'registrarPersonal', token:getAdminToken(), documento:d.doc, nombre:d.nom, cargo:d.car, fechaHora:new Date().toISOString()});
    if (r && r.ok) { const ex = getPE(); ex.push({documento:d.doc, nombre:d.nom, cargo:d.car, activo:true}); savePE(ex); ok++; }
    else { err++; }
  }
  btn.disabled = false;
  showToast(`✓ ${ok} importado${ok!==1?'s':''} ${err ? '· ' + err + ' error' + (err!==1?'es':'') : ''}`);
  mostrarPantalla('pantallaPersonal'); renderPersonalList();
});

/* ══════════════════════════════════════════
   MÓDULO: PRIMERA CONFIGURACIÓN (SETUP)
══════════════════════════════════════════ */

function _setupShowPanel(n) {
  [1, 2, 3].forEach(i => {
    const p = document.getElementById('setupPanel' + i);
    if (p) p.style.display = (i === n) ? 'flex' : 'none';
  });
}

function _setupStepEstado(icoId, estado) {
  const el = document.getElementById(icoId);
  if (!el) return;
  if (estado === 'ok')      { el.textContent = '✓'; el.className = 'ssi-ico ok'; }
  else if (estado === 'err') { el.textContent = '✗'; el.className = 'ssi-ico err'; }
  else if (estado === 'run') { el.textContent = '⏳'; el.className = 'ssi-ico run'; }
  else                       { el.textContent = '○'; el.className = 'ssi-ico pending'; }
}

async function _ejecutarSetup() {
  const overlay = document.getElementById('setupOverlay');
  if (overlay) overlay.style.display = 'flex';
  _setupShowPanel(3);

  const errEl = document.getElementById('setupErrMsg');
  const reintBtn = document.getElementById('btnSetupReintentar');
  if (errEl) errEl.style.display = 'none';
  if (reintBtn) reintBtn.style.display = 'none';

  function fallar(msg) {
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    if (reintBtn) reintBtn.style.display = '';
    const tit = document.getElementById('setupPanel3Tit');
    const sub = document.getElementById('setupPanel3Sub');
    if (tit) tit.textContent = 'Error al configurar';
    if (sub) sub.textContent = 'Corrígelo e intenta de nuevo.';
  }

  // Paso 1 + 2: obtener config del servidor
  _setupStepEstado('sIco1', 'run');
  let cfgData;
  const sCtrl = new AbortController();
  const sTimo = setTimeout(() => sCtrl.abort(), 12000);
  try {
    const r = await fetch(`${CONFIG.GS_URL}?accion=obtenerConfig&_=${Date.now()}`, {
      cache: 'no-store', signal: sCtrl.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!d || !d.ok || !d.config) throw new Error(d?.error || 'Respuesta inválida del servidor');
    cfgData = d.config;
    _setupStepEstado('sIco1', 'ok');
  } catch (e) {
    _setupStepEstado('sIco1', 'err');
    fallar('No se pudo conectar al servidor: ' + e.message);
    return;
  } finally {
    clearTimeout(sTimo);
  }

  _setupStepEstado('sIco2', 'run');
  try {
    if (!cfgData.empresa) throw new Error('El servidor no devolvió el nombre de la empresa');
    if (!cfgData.fincaNombre) throw new Error('El servidor no devolvió el nombre de la finca');
    const prev = getCfgGuardada() || {};
    const merged = { ...prev, ...cfgData, gsUrl: CONFIG.GS_URL };
    localStorage.setItem('app_config', JSON.stringify(merged));
    aplicarConfig(merged);
    aplicarEmpresaUI();
    _setupStepEstado('sIco2', 'ok');
  } catch (e) {
    _setupStepEstado('sIco2', 'err');
    fallar('Configuración incompleta: ' + e.message);
    return;
  }

  // Paso 3: autorizar dispositivo
  _setupStepEstado('sIco3', 'run');
  const authR = await autorizarDispositivo('Kiosco');
  if (!authR.ok) {
    _setupStepEstado('sIco3', 'err');
    fallar('No se pudo autorizar el dispositivo: ' + (authR.error || 'Error desconocido'));
    return;
  }
  _setupStepEstado('sIco3', 'ok');

  // Paso 4: sincronizar personal
  _setupStepEstado('sIco4', 'run');
  try {
    await cargarPersonalDesdeBackend();
  } catch { /* No crítico */ }
  _setupStepEstado('sIco4', 'ok');

  // Éxito
  const tit = document.getElementById('setupPanel3Tit');
  const sub = document.getElementById('setupPanel3Sub');
  if (tit) tit.textContent = '¡Dispositivo configurado!';
  if (sub) sub.textContent = 'El kiosco está listo para registrar asistencia.';

  setTimeout(() => {
    document.getElementById('setupOverlay').style.display = 'none';
    mostrarPantalla('pantallaMarcacion');
    setTimeout(sincronizarConfigDesdeBackend, 800);
  }, 1400);
}

/* ── Event listeners: setup ── */
document.getElementById('btnSetupComenzar').addEventListener('click', () => _setupShowPanel(2));

document.getElementById('btnSetupAtras').addEventListener('click', () => _setupShowPanel(1));

document.getElementById('btnSetupContinuar').addEventListener('click', () => {
  const urlInput = document.getElementById('setupGsUrl');
  const errEl = document.getElementById('setupUrlErr');
  const url = (urlInput ? urlInput.value : '').trim();
  if (!url || !url.startsWith('https://')) {
    if (errEl) { errEl.textContent = 'Ingresa una URL válida (debe empezar con https://)'; errEl.style.display = 'block'; }
    return;
  }
  if (errEl) errEl.style.display = 'none';
  CONFIG.GS_URL = url;
  // Guardar URL parcialmente para que el PIN pueda conectarse
  const prev = getCfgGuardada() || {};
  localStorage.setItem('app_config', JSON.stringify({ ...prev, gsUrl: url }));
  // Ocultar overlay, abrir PIN
  document.getElementById('setupOverlay').style.display = 'none';
  abrirPinScreen('setup');
});

document.getElementById('btnSetupReintentar').addEventListener('click', () => {
  // Resetear íconos
  ['sIco1','sIco2','sIco3','sIco4'].forEach(id => _setupStepEstado(id, 'pending'));
  document.getElementById('setupPanel3Tit').textContent = 'Configurando dispositivo…';
  document.getElementById('setupPanel3Sub').textContent = 'No cierres esta pantalla.';
  // Volver a panel 2 para que corrija la URL o reintente con nuevo PIN
  document.getElementById('setupOverlay').style.display = 'flex';
  _setupShowPanel(2);
});
