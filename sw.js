const CACHE_NAME = 'asistencia-palma-v2';
const ARCHIVOS_CACHE = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './lib/face-api/face-api.min.js',
  './models/tiny_face_detector_model-weights_manifest.json',
  './models/tiny_face_detector_model-shard1',
  './models/face_landmark_68_model-weights_manifest.json',
  './models/face_landmark_68_model-shard1',
  './models/face_recognition_model-weights_manifest.json',
  './models/face_recognition_model-shard1',
  './models/face_recognition_model-shard2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS_CACHE))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(nombres.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // El backend (Google Apps Script) siempre debe ir a la red, nunca a cache.
  if (url.origin !== self.location.origin) return;

  // Red primero: así cada actualización del APK se ve de inmediato.
  // El cache es solo respaldo para cuando no hay conexión.
  event.respondWith(
    fetch(event.request).then((respuestaRed) => {
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, respuestaRed.clone()));
      return respuestaRed;
    }).catch(() => caches.match(event.request).then((respuestaCache) => respuestaCache || caches.match('./index.html')))
  );
});
