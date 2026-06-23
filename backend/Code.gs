/***********************************************************
 * CONTROL DE ASISTENCIA - PALMA GRANDE S.A.S.
 * Backend Apps Script
 *
 * INSTRUCCIONES:
 * 1. Crea un Google Sheet nuevo llamado "Control_Asistencia"
 * 2. Crea una hoja llamada "Marcaciones" con esta fila de encabezado en A1:
 *    Fecha | Hora | Nombre | Documento | Cargo | Finca | Tipo | Lat | Lng | DentroGeocerca | DistanciaFacial | Timestamp
 * 3. Abre Extensiones > Apps Script, pega este código
 * 4. Implementar > Nueva implementación > Aplicación web
 *    - Ejecutar como: Yo
 *    - Quién tiene acceso: Cualquier usuario
 * 5. Copia la URL que termina en /exec y pégala en CONFIG.GS_URL del index.html
 ***********************************************************/

const SHEET_ID = "1ZjIJ_AHty-ltlFDJP_0MV4mIXAhs1oNKhKcYWNMlbC8";
const HOJA_MARCACIONES = "Marcaciones";

// Evita inyección de fórmulas: si el valor empieza con =,+,-,@ o tab,
// Sheets lo interpretaría como fórmula al mostrarlo.
function sanitizarCelda(valor) {
  if (typeof valor !== "string") return valor;
  return /^[=+\-@\t]/.test(valor) ? "'" + valor : valor;
}

function obtenerOhCrearHoja() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let hoja = ss.getSheetByName(HOJA_MARCACIONES);
  if (!hoja) {
    hoja = ss.insertSheet(HOJA_MARCACIONES);
    hoja.appendRow([
      "Fecha", "Hora", "Nombre", "Documento", "Cargo", "Finca", "Tipo",
      "Lat", "Lng", "DentroGeocerca", "DistanciaFacial", "Timestamp"
    ]);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

// Carpeta de Drive donde se guarda la foto de enrolamiento de cada empleado.
function obtenerOhCrearCarpetaFotos() {
  const carpetas = DriveApp.getFoldersByName("Fotos_Asistencia_PalmaGrande");
  if (carpetas.hasNext()) return carpetas.next();
  return DriveApp.createFolder("Fotos_Asistencia_PalmaGrande");
}

// Decodifica una foto en base64 (data URL) y la guarda en Drive,
// devolviendo una URL pública para usarla luego en el reporte/PDF.
// Se guarda una sola vez por empleado, al enrolar su rostro.
function guardarFoto(fotoDataUrl, documento, tipo) {
  if (!fotoDataUrl) return "";
  try {
    const partes = String(fotoDataUrl).split(",");
    const base64 = partes.length > 1 ? partes[1] : partes[0];
    const bytes = Utilities.base64Decode(base64);
    const nombreArchivo = (documento || "sin-doc") + "_" + (tipo || "") + "_" + Date.now() + ".jpg";
    const blob = Utilities.newBlob(bytes, "image/jpeg", nombreArchivo);
    const carpeta = obtenerOhCrearCarpetaFotos();
    const archivo = carpeta.createFile(blob);
    archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return "https://drive.google.com/uc?export=view&id=" + archivo.getId();
  } catch (err) {
    return "";
  }
}

function obtenerOhCrearHojaPersonal() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let hoja = ss.getSheetByName("Personal");
  if (!hoja) {
    hoja = ss.insertSheet("Personal");
    hoja.appendRow(["Documento", "Nombre", "Cargo", "Fecha registro", "FotoURL"]);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

// Si el empleado ya tenia una foto de enrolamiento, la borra de Drive
// para no acumular una foto nueva cada vez que se vuelve a enrolar.
function borrarFotoAnterior(fotoURL) {
  if (!fotoURL) return;
  try {
    const id = String(fotoURL).split("id=")[1];
    if (id) DriveApp.getFileById(id).setTrashed(true);
  } catch (err) {
    // El archivo ya no existe o la URL no tenia el formato esperado.
  }
}

// Busca la fila de un documento en la hoja Personal y guarda ahí la foto
// tomada al enrolar su rostro (columna FotoURL).
function guardarFotoPersonal(documento, fotoDataUrl) {
  const hoja = obtenerOhCrearHojaPersonal();
  const datos = hoja.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    if (String(datos[i][0]) === String(documento)) {
      borrarFotoAnterior(datos[i][4]);
      const fotoURL = guardarFoto(fotoDataUrl, documento, "Enrolamiento");
      hoja.getRange(i + 1, 5).setValue(fotoURL);
      return fotoURL;
    }
  }
  return "";
}

function doPost(e) {
  try {
    const datos = JSON.parse(e.postData.contents);

    if (datos.accion === 'registrarPersonal') {
      const hojaPersonal = obtenerOhCrearHojaPersonal();
      hojaPersonal.appendRow([
        sanitizarCelda(datos.documento || ""),
        sanitizarCelda(datos.nombre),
        sanitizarCelda(datos.cargo),
        new Date(),
        ""
      ]);
      return ContentService.createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (datos.accion === 'guardarFotoPersonal') {
      const fotoURL = guardarFotoPersonal(datos.documento, datos.foto);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, fotoURL: fotoURL }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const hoja = obtenerOhCrearHoja();
    const fechaHora = new Date(datos.fechaHora);

    hoja.appendRow([
      Utilities.formatDate(fechaHora, "America/Bogota", "dd/MM/yyyy"),
      Utilities.formatDate(fechaHora, "America/Bogota", "HH:mm:ss"),
      sanitizarCelda(datos.nombre),
      sanitizarCelda(datos.documento || ""),
      sanitizarCelda(datos.cargo || ""),
      sanitizarCelda(datos.finca),
      sanitizarCelda(datos.tipo),
      datos.lat || "",
      datos.lng || "",
      datos.dentroGeocerca ? "SI" : "NO",
      datos.distanciaFacial ? datos.distanciaFacial.toFixed(3) : "",
      new Date()
    ]);

    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Sheets puede guardar la celda "Fecha" como texto o, si interpretó el valor
// como fecha, como un objeto Date real. Esto normaliza ambos casos al mismo
// formato de texto para poder compararlos.
function normalizarFecha(valor) {
  // instanceof Date puede fallar si el valor viene de otro "realm" de JS
  // (pasa con algunos valores devueltos por getValues() en Apps Script),
  // por eso se verifica con Object.prototype.toString en vez de instanceof.
  if (Object.prototype.toString.call(valor) === "[object Date]") {
    return Utilities.formatDate(valor, "America/Bogota", "dd/MM/yyyy");
  }
  return String(valor);
}

// Misma normalización que normalizarFecha pero para la columna "Hora":
// Sheets puede interpretar el texto "HH:mm:ss" como un valor de hora real
// y devolverlo como objeto Date al leerlo con getValues().
function normalizarHora(valor) {
  if (Object.prototype.toString.call(valor) === "[object Date]") {
    return Utilities.formatDate(valor, "America/Bogota", "HH:mm:ss");
  }
  return String(valor);
}

function doGet(e) {
  const accion = e.parameter && e.parameter.accion;

  if (accion === 'marcasHoy') {
    const documento = String(e.parameter.documento || "").trim();
    const hoja = obtenerOhCrearHoja();
    const datos = hoja.getDataRange().getValues();
    const hoy = Utilities.formatDate(new Date(), "America/Bogota", "dd/MM/yyyy");

    const marcas = [];
    for (let i = 1; i < datos.length; i++) {
      const [fecha, , , doc, , , tipo] = datos[i];
      if (normalizarFecha(fecha) === hoy && String(doc) === documento) marcas.push(tipo);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, marcas: marcas }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (accion === 'resumenDashboard') {
    return calcularResumenDashboard(e.parameter.fecha);
  }

  // Permite probar que el endpoint está vivo abriendo la URL en el navegador
  return ContentService.createTextOutput(JSON.stringify({ status: "Control_Asistencia backend activo" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Mapa documento -> FotoURL tomada al enrolar el rostro de cada empleado.
function obtenerFotosPorDocumento() {
  const hojaPersonal = obtenerOhCrearHojaPersonal();
  const datos = hojaPersonal.getDataRange().getValues();
  const fotos = {};
  for (let i = 1; i < datos.length; i++) {
    fotos[String(datos[i][0])] = datos[i][4] || "";
  }
  return fotos;
}

/**
 * Indicadores para el dashboard de Dirección Agronómico: asistencia,
 * tardanzas, jornadas completas y desglose por finca, para una fecha
 * puntual (por defecto hoy). Incluye el listado detallado por persona
 * con la URL de la foto de enrolamiento, para el reporte PDF.
 */
function calcularResumenDashboard(fechaParam) {
  const hoy = Utilities.formatDate(new Date(), "America/Bogota", "dd/MM/yyyy");
  const fecha = fechaParam || hoy;

  const hoja = obtenerOhCrearHoja();
  const datos = hoja.getDataRange().getValues();
  const fotosPorDocumento = obtenerFotosPorDocumento();

  const HORA_TOLERANCIA_ENTRADA = 6.25; // 6:15 am

  const porPersona = {}; // documento -> {nombre, cargo, finca, Entrada, Salida, fotoURL}

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const fechaFila = fila[0], hora = normalizarHora(fila[1]), nombre = fila[2], documento = fila[3],
      cargo = fila[4], finca = fila[5], tipo = fila[6];
    if (normalizarFecha(fechaFila) !== fecha) continue;

    const clave = String(documento);
    if (!porPersona[clave]) porPersona[clave] = { nombre, cargo, finca, fotoURL: fotosPorDocumento[clave] || "" };
    porPersona[clave][tipo] = hora;
  }

  let tardanzas = 0, jornadasCompletas = 0, totalHoras = 0;
  const porFinca = {};
  const filas = [];

  const horaADecimal = (hStr) => {
    const [h, mi, s] = String(hStr).split(":").map(Number);
    return h + mi / 60 + (s || 0) / 3600;
  };

  Object.keys(porPersona).forEach(documento => {
    const p = porPersona[documento];
    porFinca[p.finca] = (porFinca[p.finca] || 0) + 1;

    if (p.Entrada) {
      const [h, mi] = String(p.Entrada).split(":").map(Number);
      if ((h + mi / 60) > HORA_TOLERANCIA_ENTRADA) tardanzas++;
    }

    let horasLaboradas = "";
    if (p.Entrada && p.Salida) {
      jornadasCompletas++;
      const tiempoAlmuerzo = (p["Inicio almuerzo"] && p["Fin almuerzo"])
        ? horaADecimal(p["Fin almuerzo"]) - horaADecimal(p["Inicio almuerzo"]) : 0;
      const horasDecimal = horaADecimal(p.Salida) - horaADecimal(p.Entrada) - tiempoAlmuerzo;
      totalHoras += horasDecimal;
      const horasEnteras = Math.floor(horasDecimal);
      const minutos = Math.round((horasDecimal - horasEnteras) * 60);
      horasLaboradas = horasEnteras + "h " + minutos + "m";
    }

    filas.push({
      documento: documento, nombre: p.nombre, cargo: p.cargo, finca: p.finca,
      entrada: p.Entrada || "", salida: p.Salida || "", fotoURL: p.fotoURL || "",
      horasLaboradas: horasLaboradas
    });
  });

  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    fecha: fecha,
    totalPersonas: Object.keys(porPersona).length,
    tardanzas: tardanzas,
    jornadasCompletas: jornadasCompletas,
    totalHoras: totalHoras.toFixed(1),
    porFinca: porFinca,
    filas: filas
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Función auxiliar: calcula horas trabajadas, déficit y horas extra
 * Se puede llamar manualmente o programar como trigger diario
 * (Apps Script > Activadores > Añadir activador > calcularResumenDiario > diario).
 * Lee todas las marcaciones del día y agrupa por Nombre+Finca, y las
 * guarda en una única hoja "Resumen" acumulativa (una fila por persona/día).
 */
function obtenerOhCrearHojaResumen() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let hoja = ss.getSheetByName("Resumen");
  if (!hoja) {
    hoja = ss.insertSheet("Resumen");
    hoja.appendRow(["Fecha", "Nombre", "Documento", "Cargo", "Finca", "Entrada", "Salida", "Horas trabajadas", "Déficit (min)", "Extra (min)"]);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function calcularResumenDiario() {
  const hoja = obtenerOhCrearHoja();
  const datos = hoja.getDataRange().getValues();
  const hoy = Utilities.formatDate(new Date(), "America/Bogota", "dd/MM/yyyy");

  const HORARIO = {
    entrada: 6.0, almuerzoInicio: 12.0, almuerzoFin: 13.0,
    salida: 14.75, salidaSabado: 11.75
  };

  const marcasHoy = {}; // { "Nombre|Finca": {Entrada:.., 'Inicio almuerzo':.., ...} }

  for (let i = 1; i < datos.length; i++) {
    const [fecha, hora, nombre, documento, cargo, finca, tipo] = datos[i];
    if (normalizarFecha(fecha) !== hoy) continue;
    const clave = nombre + "|" + finca;
    if (!marcasHoy[clave]) marcasHoy[clave] = { cargo, documento };
    marcasHoy[clave][tipo] = normalizarHora(hora);
  }

  const filasNuevas = [];

  Object.keys(marcasHoy).forEach(clave => {
    const [nombre, finca] = clave.split("|");
    const m = marcasHoy[clave];
    if (!m["Entrada"] || !m["Salida"]) {
      filasNuevas.push([hoy, nombre, m.documento || "", m.cargo || "", finca, m["Entrada"]||"", m["Salida"]||"", "INCOMPLETO", "", ""]);
      return;
    }
    const horaADecimal = (hStr) => {
      const [h, mi, s] = hStr.split(":").map(Number);
      return h + mi/60 + s/3600;
    };
    const entrada = horaADecimal(m["Entrada"]);
    const salida = horaADecimal(m["Salida"]);
    const esSabado = new Date().getDay() === 6;
    const horaCierre = esSabado ? HORARIO.salidaSabado : HORARIO.salida;
    const tiempoAlmuerzo = (m["Inicio almuerzo"] && m["Fin almuerzo"])
      ? horaADecimal(m["Fin almuerzo"]) - horaADecimal(m["Inicio almuerzo"]) : 0;

    const horasTrabajadas = (salida - entrada - tiempoAlmuerzo);
    const deficitMin = Math.max(0, (HORARIO.entrada - entrada) * 60) + Math.max(0, (horaCierre - salida) * 60);
    const extraMin = Math.max(0, (salida - horaCierre) * 60);

    filasNuevas.push([hoy, nombre, m.documento || "", m.cargo || "", finca, m["Entrada"], m["Salida"], horasTrabajadas.toFixed(2), deficitMin.toFixed(0), extraMin.toFixed(0)]);
  });

  const hojaResumen = obtenerOhCrearHojaResumen();

  // Si ya se calculó el resumen de hoy antes, borra esas filas para no duplicar
  const existentes = hojaResumen.getDataRange().getValues();
  for (let i = existentes.length - 1; i >= 1; i--) {
    if (normalizarFecha(existentes[i][0]) === hoy) hojaResumen.deleteRow(i + 1);
  }

  if (filasNuevas.length) {
    hojaResumen.getRange(hojaResumen.getLastRow() + 1, 1, filasNuevas.length, filasNuevas[0].length).setValues(filasNuevas);
  }
}
