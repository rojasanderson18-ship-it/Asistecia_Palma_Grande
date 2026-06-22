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

function obtenerOhCrearHojaPersonal() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let hoja = ss.getSheetByName("Personal");
  if (!hoja) {
    hoja = ss.insertSheet("Personal");
    hoja.appendRow(["Documento", "Nombre", "Cargo", "Fecha registro"]);
    hoja.setFrozenRows(1);
  }
  return hoja;
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
        new Date()
      ]);
      return ContentService.createTextOutput(JSON.stringify({ ok: true }))
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

  // Permite probar que el endpoint está vivo abriendo la URL en el navegador
  return ContentService.createTextOutput(JSON.stringify({ status: "Control_Asistencia backend activo" }))
    .setMimeType(ContentService.MimeType.JSON);
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
    marcasHoy[clave][tipo] = hora;
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
