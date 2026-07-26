# Asistencia Palma Grande

Sistema de asistencia biométrica por **reconocimiento facial** para plantaciones y operaciones de campo. PWA offline-first + backend serverless en Google Apps Script, sin costos de infraestructura recurrentes.

[![Demo en vivo](https://img.shields.io/badge/demo-en%20vivo-2E7D32?style=flat-square)](https://rojasanderson18-ship-it.github.io/Asistecia_Palma_Grande/)
[![Capacitor](https://img.shields.io/badge/Capacitor-8.4-119EFF?style=flat-square&logo=capacitor&logoColor=white)](https://capacitorjs.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

---

## Características

- **Marcación por reconocimiento facial** (entrada/salida) con `face-api.js`, corriendo 100% en el dispositivo — ningún rostro ni foto viaja a servidores de terceros.
- **Modo offline-first**: si no hay conexión, la marcación se guarda en cola local y se sincroniza automáticamente al recuperar señal.
- **PIN administrativo sin texto plano**: se hashea (SHA-256) en el dispositivo y se valida contra un hash almacenado en el backend; nunca se guarda el PIN ni su hash en el frontend.
- **Sesiones con expiración**: tokens de admin (15 min) y supervisor (5 min) emitidos por el backend, nunca persistidos más allá de la sesión.
- **Gestión de personal completa**: alta/edición/baja, importación masiva por CSV, enrolamiento y re-enrolamiento biométrico, respaldo cifrado (AES-256-GCM + PBKDF2) de los rostros enrolados para migrar de dispositivo sin perder datos.
- **Geocercas**: valida que la marcación ocurra dentro de un radio configurable de la finca.
- **Horarios configurables por día de la semana**, con tolerancias de entrada/salida y descuento de tiempo de almuerzo (o "jornada continua" por trabajador para quien no aplica ese descuento).
- **Cálculo de puntualidad, déficit y horas extra en el servidor** — las horas extra requieren autorización explícita de un administrador antes de contarse o aparecer en reportes impresos.
- **Autorización de dispositivos kiosco**: cada tablet/equipo debe ser autorizado por un admin; se puede listar y revocar acceso en cualquier momento.
- **Dashboard de reportes** (`reporte.html`) con filtros por fecha, finca, cargo y persona, detección de quienes no se registraron, y exportación a PDF.
- **Auditoría**: toda acción administrativa (autorizar, eliminar, cambiar PIN, revocar dispositivo, etc.) queda registrada.
- **Empaquetado Android** vía Capacitor, con compilación automática de APK en CI.

## Arquitectura

```
┌─────────────────────────────┐      HTTPS (JSON)      ┌──────────────────────────────┐
│   PWA (www/, kiosco)        │ ─────────────────────▶ │  Google Apps Script          │
│                              │ ◀───────────────────── │  (backend/Code.gs)           │
│  face-api.js (on-device)    │                         │                              │
│  Service Worker (offline)   │                         │  · Login PIN → token sesión  │
│  Cola offline (localStorage)│                         │  · Validación de sesión      │
│  Geolocalización (geocerca) │                         │  · Reglas de puntualidad     │
└──────────────┬───────────────┘                         │  · Auditoría                 │
               │                                         └───────────────┬──────────────┘
               │ instalable / standalone                                 │
               ▼                                                         ▼
      ┌──────────────────┐                                  ┌─────────────────────────┐
      │  Capacitor (APK)  │                                  │  Google Sheets (BD)      │
      │  android/          │                                  │  Marcaciones · Personal  │
      └──────────────────┘                                  │  Dispositivos · Auditoría│
                                                              └─────────────────────────┘

      reporte.html (dashboard independiente, login por PIN, consume el mismo backend)
```

`www/` es la **fuente única de verdad** del frontend; el contenido de la raíz del repo es un espejo generado (`sync.sh` o el workflow `sync-pages.yml`) porque GitHub Pages sirve desde la raíz. El proyecto Android (Capacitor) también empaqueta `www/`.

## Requisitos

- Node.js 18+ y npm (solo para tooling de Capacitor/Android).
- Cuenta de Google con acceso a Google Apps Script y Google Sheets.
- Android Studio / JDK 21 si vas a compilar el APK localmente (opcional: la CI ya lo hace).
- Un navegador con soporte de cámara y `getUserMedia` para probar el frontend.

## Instalación rápida

### 1. Backend (Google Apps Script)

1. Crea un Google Sheet nuevo (o usa uno existente) y copia su ID.
2. Abre [script.google.com](https://script.google.com), crea un proyecto nuevo y pega el contenido de [`backend/Code.gs`](backend/Code.gs).
3. Reemplaza `SHEET_ID` con el ID de tu Sheet.
4. Ejecuta una vez la función `setPin('TU_PIN_INICIAL')` desde el editor para fijar el PIN de administrador (nunca se guarda en el repo).
5. Implementar → **Nueva implementación** → tipo "Aplicación web", acceso "Cualquier usuario". Copia la URL `/exec` generada.
6. Cada vez que modifiques `Code.gs`, debes volver a **Implementar → Gestionar implementaciones → Nueva versión** para que los cambios surtan efecto.

### 2. Frontend

```bash
git clone https://github.com/rojasanderson18-ship-it/Asistecia_Palma_Grande.git
cd Asistecia_Palma_Grande
npm start          # sirve www/ en http://localhost:8080
```

Abre la app, entra a **Configuración** con el PIN inicial y pega la URL del backend (`.../exec`) en el campo correspondiente.

### 3. Android (Capacitor)

```bash
npm install
npm run cap:sync     # sincroniza www/ con el proyecto android/
npm run cap:android   # abre el proyecto en Android Studio
```

La CI (`.github/workflows/build-apk.yml`) compila un APK debug en cada push relevante y lo publica como artefacto descargable desde la pestaña *Actions*.

## Estructura del proyecto

```
Asistecia_Palma_Grande/
├── www/                    # ← fuente única de verdad del frontend
│   ├── index.html
│   ├── manifest.json
│   ├── sw.js                # Service Worker (cache-first + red primero)
│   ├── css/styles.css
│   ├── js/
│   │   ├── config.js         # configuración local, helpers de caché
│   │   ├── auth.js           # login PIN, tokens de sesión, dispositivos
│   │   ├── geolocation.js     # validación de geocerca
│   │   ├── offline-queue.js   # cola de marcaciones sin conexión
│   │   ├── face-recognition.js# enrolamiento y matching facial
│   │   ├── attendance.js      # máquina de estados de marcación
│   │   ├── admin.js           # panel administrativo completo
│   │   ├── ui.js               # modales, toasts, pantallas
│   │   └── app.js              # bootstrap y orquestación
│   ├── lib/face-api/          # face-api.js (vendorizado)
│   └── models/                 # modelos de detección/reconocimiento facial
├── backend/
│   └── Code.gs                 # Google Apps Script (API + lógica de negocio)
├── android/                     # proyecto Capacitor
├── reporte.html                 # dashboard de reportes (login propio, consume el backend)
├── sync.sh                       # sincroniza www/ → mirrors en la raíz
├── capacitor.config.json
└── manifest.json, index.html, css/, js/, sw.js  # espejos de www/ para GitHub Pages
```

## Seguridad y privacidad

Este proyecto maneja datos biométricos y personales; las siguientes reglas son de cumplimiento obligatorio en todo el código:

- **El PIN nunca se almacena en texto plano, hash reversible ni configuración local.** Se hashea con SHA-256 en el cliente y se valida en el backend contra un hash guardado en `PropertiesService`.
- **Ningún dato sensible vive en el frontend**: nombres, documentos, cargos, coordenadas, radios de geocerca y URLs internas se sirven siempre desde el backend autenticado, nunca hardcodeados en el código fuente ni en el repositorio.
- **Los descriptores faciales se almacenan solo en el dispositivo** (`localStorage`), nunca se suben al backend. El respaldo/restauración entre dispositivos usa cifrado **AES-256-GCM** con clave derivada por **PBKDF2** (150.000 iteraciones) a partir de una contraseña elegida por el administrador — `btoa` se usa únicamente como codificación binario→texto del resultado cifrado, nunca como mecanismo de seguridad.
- **Toda acción administrativa queda auditada** (autorizaciones, eliminaciones, cambios de PIN, revocación de dispositivos) con fecha, identificador de dispositivo y resultado.
- **Sesiones de corta duración**: 15 minutos para administrador, 5 para supervisor, con validación server-side en cada solicitud sensible.
- **Fotos de enrolamiento**: se sirven únicamente vía el endpoint autenticado `obtenerFoto`, nunca por URL pública directa.

## Configuración de horarios

Desde **Configuración → Horario laboral** se define, por día de la semana:

| Campo | Descripción |
|---|---|
| Activo | Si ese día hay jornada laboral |
| Entrada / Salida | Horario oficial del día |
| Tol. E / Tol. S | Minutos de tolerancia antes de marcar tardanza o salida anticipada |
| Almuerzo | Minutos que se descuentan de las horas trabajadas ese día |

Un trabajador puede marcarse como **"Jornada continua"** en su ficha para que no se le descuente el tiempo de almuerzo (por ejemplo, si no sale a almorzar). Las **horas extra** calculadas por exceder la jornada configurada no se cuentan ni se imprimen en reportes hasta que un administrador las autoriza explícitamente desde `reporte.html`.

## Flujo de marcación

1. El trabajador se ubica frente a la cámara del kiosco; `face-api.js` detecta el rostro y calcula su descriptor facial en el dispositivo.
2. El descriptor se compara contra los rostros enrolados localmente (o el trabajador puede identificarse por cédula si la cámara falla repetidas veces).
3. Se valida la **geocerca** (distancia a la finca) y el **horario configurado** del día.
4. Si hay conexión, se envía la marcación al backend (`accion=marcar`); si no, se guarda en la **cola offline** y se reintenta automáticamente.
5. El backend determina el tipo (Entrada/Salida), calcula puntualidad y minutos de diferencia según el horario real del día, y registra todo en la hoja `Marcaciones` con auditoría.
6. Un administrador puede revisar el día en el panel o en `reporte.html`, autorizar salidas anticipadas u horas extra puntuales, y exportar el reporte a PDF.

## Licencia

Distribuido bajo licencia [MIT](LICENSE).

## Contacto

**Rojas Anderson** — [rojasanderson18@gmail.com](mailto:rojasanderson18@gmail.com)
Repositorio: [github.com/rojasanderson18-ship-it/Asistecia_Palma_Grande](https://github.com/rojasanderson18-ship-it/Asistecia_Palma_Grande)
