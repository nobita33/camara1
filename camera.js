/**
 * camera.js — FASE 1
 *
 * Responsabilidad única: pedir permiso, abrir la cámara frontal
 * (selfie) del móvil con la mayor resolución razonable, y dejarla
 * lista dentro de un <video>. Nada de detección ni tracking todavía — eso llega en
 * fases posteriores y consumirá los frames que este módulo expone.
 */

const Camera = (() => {

  let stream = null;

  /**
   * Comprueba los requisitos mínimos antes de tocar getUserMedia,
   * para poder dar un mensaje de error útil en vez de una excepción
   * críptica del navegador.
   */
  function checkPreconditions() {
    const isSecure = window.isSecureContext; // true en https:// y en localhost
    if (!isSecure) {
      throw new Error(
        "Esta página no se está sirviendo por HTTPS. Safari bloquea la " +
        "cámara en orígenes no seguros. Consulta el README para desplegar " +
        "en Vercel o abrir un túnel HTTPS."
      );
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(
        "Este navegador no expone getUserMedia. Prueba con Safari o Chrome " +
        "actualizados."
      );
    }
  }

  /**
   * Pide la cámara frontal (selfie) con la resolución más alta que el
   * dispositivo quiera darnos. Usamos 'ideal' en vez de 'exact' para
   * que el navegador pueda hacer fallback en vez de fallar.
   */
  async function start(videoEl) {
    checkPreconditions();

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 60 },
      },
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);

    videoEl.srcObject = stream;
    videoEl.setAttribute("playsinline", "true"); // evita fullscreen forzado en iOS
    videoEl.muted = true;

    // iOS Safari a veces no arranca el <video> solo con autoplay;
    // el play() explícito tras la interacción del usuario (el tap en
    // START) es lo que lo garantiza de forma fiable.
    await videoEl.play();

    return stream;
  }

  function stop() {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  function getActiveStream() {
    return stream;
  }

  return { start, stop, getActiveStream };
})();
