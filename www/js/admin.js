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
}

/* ── PIN screen ── */
let _pinDest = 'menu';

function abrirPinScreen(dest) {
  _pinDest = dest || 'menu';
  const pinInput = document.getElementById('pinInput');
  if (pinInput) pinInput.value = '';
  mostrarPantalla('pantallaPin');
}

document.getElementById('btnPinCancelar').onclick = () => mostrarPantalla('pantallaMarcacion');
document.getElementById('btnPinConfirmar').onclick = async () => {
  const btn = document.getElementById('btnPinConfirmar');
  const val = document.getElementById('pinInput').value;
  const errEl = document.getElementById('pinErr');
  btn.disabled = true;
  const result = await autenticarPin(val);
  btn.disabled = false;
  if (result.ok) {
    if (_pinDest === 'enrolar') {
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
  if (repFecha) repFecha.value = hoy.toISOString().slice(0, 10);
  mostrarPantalla('pantallaReporte');
  cargarReporte();
};

document.getElementById('menuConfig').onclick = () => abrirConfig();

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
  if (!doc) { alert('Escribe el documento'); return; }
  if (!/^\d+$/.test(doc)) { alert('Solo números'); return; }
  if (!nom) { alert('Escribe el nombre'); return; }
  if (!car) { alert('Selecciona cargo'); return; }
  if (getPC().some(p => p.nombre.toLowerCase() === nom.toLowerCase())) { alert('Ya existe ese nombre'); return; }
  if (getPorDoc(doc)) { alert('Ya existe ese documento'); return; }
  const btn = document.getElementById('btnGuardarPersonal'); btn.disabled = true;
  const r = await enviarConResp({accion:'registrarPersonal', documento:doc, nombre:nom, cargo:car, fechaHora:new Date().toISOString()});
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
  lista.onclick = e => {
    const btn = e.target.closest('button[data-nombre]'); if (!btn) return;
    const nombre = decodeURIComponent(btn.dataset.nombre);
    if (!confirm(`¿Borrar el rostro de ${nombre}? Deberá enrolarse nuevamente.`)) return;
    deleteRostro(nombre); showToast('Rostro eliminado'); abrirGestionRostros();
  };
  mostrarPantalla('pantallaRostros');
}
document.getElementById('menuRostros').onclick = abrirGestionRostros;
document.getElementById('btnVolverDesdeRostros').onclick = () => mostrarPantalla('pantallaMenu');
document.getElementById('btnBorrarTodosRostros').onclick = () => {
  const n = Object.keys(getRostros()).length;
  if (!n) { showToast('No hay rostros enrolados'); return; }
  if (!confirm(`¿Borrar los ${n} rostros enrolados? Todos deberán enrolarse nuevamente.`)) return;
  localStorage.removeItem('rostros_enrolados');
  localStorage.removeItem('rostros_meta');
  showToast('Todos los rostros eliminados');
  abrirGestionRostros();
};

/* ── Configuración ── */
function buildTimePick(id) {
  const wrap = document.getElementById(id); if (!wrap) return;
  const selH = document.createElement('select');
  for (let h = 0; h < 24; h++) { const o = document.createElement('option'); o.value = h; o.textContent = String(h).padStart(2, '0'); selH.appendChild(o); }
  const selM = document.createElement('select');
  [0, 15, 30, 45].forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = String(m).padStart(2, '0'); selM.appendChild(o); });
  const sep = document.createElement('span'); sep.className = 'tp-sep'; sep.textContent = ':';
  const ampm = document.createElement('span'); ampm.className = 'tp-ampm';
  selH.addEventListener('change', () => _updAmpm(selH, ampm));
  wrap.innerHTML = ''; wrap.append(selH, sep, selM, ampm);
  return {selH, selM, ampm};
}
function _updAmpm(selH, ampm) { ampm.textContent = parseInt(selH.value) < 12 ? 'a.m.' : 'p.m.'; }
function setTimePick(id, decimal) {
  const wrap = document.getElementById(id); if (!wrap) return;
  const selH = wrap.querySelector('select:nth-child(1)');
  const selM = wrap.querySelector('select:nth-child(3)');
  const ampm = wrap.querySelector('.tp-ampm');
  if (!selH || !selM) return;
  const hh = Math.floor(decimal), mm = Math.round((decimal - hh) * 60);
  selH.value = hh;
  const mq = [0, 15, 30, 45].reduce((a, b) => Math.abs(b - mm) < Math.abs(a - mm) ? b : a, 0);
  selM.value = mq;
  if (ampm) _updAmpm(selH, ampm);
}
function getTimePick(id) {
  const wrap = document.getElementById(id); if (!wrap) return null;
  const selH = wrap.querySelector('select:nth-child(1)');
  const selM = wrap.querySelector('select:nth-child(3)');
  if (!selH || !selM) return null;
  return parseInt(selH.value) + parseInt(selM.value) / 60;
}

function abrirConfig() {
  ['cfgEntrada', 'cfgSalida', 'cfgSalidaSab'].forEach(id => {
    if (!document.getElementById(id).querySelector('select')) buildTimePick(id);
  });
  const cfg = getCfgGuardada() || {};
  const gsUrlEl = document.getElementById('cfgGsUrl');
  if (gsUrlEl) gsUrlEl.value = cfg.gsUrl || '';
  const empresaEl = document.getElementById('cfgEmpresa');
  if (empresaEl) empresaEl.value = cfg.empresa || CONFIG.EMPRESA.nombre;
  document.getElementById('cfgNombreFinca').value = cfg.fincaNombre || CONFIG.FINCA.nombre;
  document.getElementById('cfgLat').value = cfg.lat != null ? cfg.lat : '';
  document.getElementById('cfgLng').value = cfg.lng != null ? cfg.lng : '';
  document.getElementById('cfgRadio').value = cfg.radio != null ? cfg.radio : CONFIG.FINCA.radioMetros;
  setTimePick('cfgEntrada', cfg.entrada != null ? cfg.entrada : CONFIG.HORARIO.entrada);
  setTimePick('cfgSalida', cfg.salida != null ? cfg.salida : CONFIG.HORARIO.salida);
  setTimePick('cfgSalidaSab', cfg.salidaSab != null ? cfg.salidaSab : CONFIG.HORARIO.salidaSabado);
  const u = cfg.umbral != null ? cfg.umbral : CONFIG.UMBRAL_FACIAL;
  document.getElementById('cfgUmbral').value = u;
  document.getElementById('cfgUmbralVal').textContent = parseFloat(u).toFixed(2);
  mostrarPantalla('pantallaConfig');
}

document.getElementById('cfgUmbral').addEventListener('input', function() {
  document.getElementById('cfgUmbralVal').textContent = parseFloat(this.value).toFixed(2);
});
document.getElementById('btnUsarUbicacion').addEventListener('click', () => {
  if (!navigator.geolocation) { alert('GPS no disponible'); return; }
  const btn = document.getElementById('btnUsarUbicacion');
  btn.textContent = 'Obteniendo ubicación…'; btn.disabled = true;
  navigator.geolocation.getCurrentPosition(pos => {
    document.getElementById('cfgLat').value = pos.coords.latitude.toFixed(6);
    document.getElementById('cfgLng').value = pos.coords.longitude.toFixed(6);
    btn.textContent = '✓ Ubicación capturada'; btn.disabled = false;
  }, () => { btn.textContent = 'Usar mi ubicación actual'; btn.disabled = false; alert('No se pudo obtener la ubicación'); }, {enableHighAccuracy:true, timeout:8000});
});
document.getElementById('btnGuardarConfig').addEventListener('click', async () => {
  const gsUrlVal = (document.getElementById('cfgGsUrl') || {}).value || '';
  const empresaVal = (document.getElementById('cfgEmpresa') || {}).value || '';
  const fincaNombre = document.getElementById('cfgNombreFinca').value.trim();
  const lat = parseFloat(document.getElementById('cfgLat').value);
  const lng = parseFloat(document.getElementById('cfgLng').value);
  const radio = parseInt(document.getElementById('cfgRadio').value);
  if (!fincaNombre) { alert('Escribe el nombre de la finca'); return; }
  if (isNaN(lat) || isNaN(lng)) { alert('Las coordenadas no son válidas'); return; }
  if (isNaN(radio) || radio < 50) { alert('El radio mínimo es 50 metros'); return; }
  const prev = getCfgGuardada() || {};
  const cfg = {
    ...prev,
    gsUrl: gsUrlVal.trim() || prev.gsUrl || '',
    empresa: empresaVal.trim() || prev.empresa || '',
    fincaNombre, lat, lng, radio,
    entrada: getTimePick('cfgEntrada'),
    salida: getTimePick('cfgSalida'),
    salidaSab: getTimePick('cfgSalidaSab'),
    umbral: parseFloat(document.getElementById('cfgUmbral').value),
  };
  // Eliminar cualquier vestigio de PIN local (migración de versiones anteriores)
  delete cfg.pin;
  delete cfg.pinHash;
  delete cfg.pinSha;
  delete cfg._salt;
  delete cfg.nombreFinca;
  localStorage.setItem('app_config', JSON.stringify(cfg));
  aplicarConfig(cfg);
  aplicarEmpresaUI();
  mostrarPantalla('pantallaMenu');
  showToast('✓ Configuración guardada');
  setTimeout(() => { chkGps(); cargarPersonalDesdeBackend(); }, 500);
});
document.getElementById('btnVolverDesdeConfig').addEventListener('click', () => mostrarPantalla('pantallaMenu'));
document.getElementById('btnCancelarConfig').addEventListener('click', () => mostrarPantalla('pantallaMenu'));

/* ── Reporte de deuda ── */
document.getElementById('btnVolverDesdeReporte').onclick = () => mostrarPantalla('pantallaMenu');
document.getElementById('btnRepCargar').onclick = cargarReporte;

async function cargarReporte() {
  const fechaVal = document.getElementById('repFecha').value;
  if (!fechaVal) return;
  const estEl = document.getElementById('repEstado');
  const tabEl = document.getElementById('repTabla');
  const resEl = document.getElementById('repResumen');
  estEl.style.display = 'block'; estEl.textContent = 'Cargando...';
  tabEl.innerHTML = ''; resEl.style.display = 'none';
  if (!CONFIG.GS_URL || CONFIG.GS_URL.includes('PEGAR')) {
    estEl.textContent = '⚠️ Configura la URL del servidor primero.'; return;
  }
  let datos = [];
  try {
    const r = await fetch(`${CONFIG.GS_URL}?accion=resumenDia&fecha=${fechaVal}&finca=${encodeURIComponent(CONFIG.FINCA.nombre)}&_=${Date.now()}`, {cache:'no-store'});
    const j = await r.json();
    if (j && Array.isArray(j.empleados)) datos = j.empleados;
  } catch {}
  if (!datos.length) {
    const cola = JSON.parse(localStorage.getItem('cola') || '[]');
    const marcasFecha = cola.filter(m => m.fechaHora && m.fechaHora.startsWith(fechaVal));
    const porNombre = {};
    marcasFecha.forEach(m => {
      if (!porNombre[m.nombre]) porNombre[m.nombre] = {nombre:m.nombre, marcas:[], minutosDeuda:0, puntualidad:[]};
      porNombre[m.nombre].marcas.push(m.tipo);
      if (m.minutosDeuda) porNombre[m.nombre].minutosDeuda += m.minutosDeuda;
      if (m.puntualidad && m.puntualidad !== 'ok') porNombre[m.nombre].puntualidad.push({tipo:m.tipo, estado:m.puntualidad, minutos:m.minutosDeuda||0});
    });
    datos = Object.values(porNombre);
    if (!datos.length) { estEl.textContent = 'No hay datos offline para esta fecha.'; return; }
  }
  estEl.style.display = 'none'; resEl.style.display = 'block';
  let totalTarde = 0, totalTemprano = 0, totalMin = 0;
  datos.forEach(e => {
    const p = e.puntualidad || [];
    p.forEach(x => { if (x.estado === 'tarde') totalTarde++; if (x.estado === 'temprano') totalTemprano++; });
    totalMin += e.minutosDeuda || 0;
  });
  document.getElementById('repCntTarde').textContent = totalTarde;
  document.getElementById('repCntTemprano').textContent = totalTemprano;
  document.getElementById('repCntDeuda').textContent = totalMin;
  tabEl.innerHTML = datos.map(e => {
    const tieneDeuda = (e.minutosDeuda || 0) > 0;
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
    </div>`;
  }).join('') || '<div style="text-align:center;color:var(--t2);font-size:13px;padding:20px 0;">Sin registros</div>';
}
