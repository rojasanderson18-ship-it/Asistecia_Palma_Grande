/* ── MÓDULO: Motor de audio via Web Audio API ──
   Sin dependencias externas. Funciona offline.
   Expone window.playSound(tipo) para uso desde cualquier módulo.
*/
let _audioCtx = null;
function _getCtx() {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audioCtx;
}
window.playSound = function(tipo) {
  try {
    const ctx = _getCtx();
    if (tipo === 'success') {
      // Tres tonos ascendentes — Do, Mi, Do (octava alta)
      [[523.25, 0, .18], [659.25, .13, .18], [1046.5, .26, .48]].forEach(([f, t, d]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, ctx.currentTime + t);
        g.gain.linearRampToValueAtTime(0.22, ctx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + d);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + d + 0.05);
      });
    } else if (tipo === 'error') {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sawtooth'; o.frequency.value = 185;
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.45);
    }
  } catch(e) { /* Dispositivo sin soporte o bloqueado por política del browser */ }
};

/* ── Voz (confirmación de Entrada/Salida) ──
   Usa la Web Speech API; si el dispositivo no la soporta, no hace nada
   (silencioso, sin romper el flujo de marcación). */
window.decirBienvenida = function(nombre, esEntrada) {
  try {
    if (!('speechSynthesis' in window)) return;
    const frase = (esEntrada ? 'Bienvenido, ' : 'Hasta luego, ') + (nombre || '');
    const u = new SpeechSynthesisUtterance(frase);
    u.lang = 'es-CO';
    u.rate = 1;
    speechSynthesis.cancel(); // no encolar sobre una locución anterior sin terminar
    speechSynthesis.speak(u);
  } catch (e) { /* Dispositivo sin soporte o bloqueado por política del browser */ }
};
