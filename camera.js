/**
 * camera.js — Cámara selfie (frontal)
 *
 * Pide permiso, abre la cámara frontal del móvil y la deja lista en un
 * <video>. Resolución bajada a 1280×720: la detección se ejecuta ahora
 * en CADA frame, así que interesa un frame de origen más ligero; 1080p
 * no aporta precisión útil a este uso y sí carga la CPU.
 */

const Camera = (() => {

  let stream = null;

  function checkPreconditions() {
    if (!window.isSecureContext) {
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

  async function start(videoEl) {
    checkPreconditions();

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
      },
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);

    videoEl.srcObject = stream;
    videoEl.setAttribute("playsinline", "true");
    videoEl.muted = true;
    await videoEl.play();

    // Enfoque continuo si el dispositivo lo permite: una carta a
    // distancia de brazo con enfoque fijo puede salir borrosa y arruinar
    // la detección de bordes. No todos los navegadores lo soportan;
    // si falla, se ignora.
    try {
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes("continuous")) {
        await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      }
    } catch (e) {
      /* opcional: si no se puede, seguimos */
    }

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
