/**
 * app.js — FASE 1
 *
 * Solo orquesta la UI: cambia de pantalla, arranca/para la cámara y
 * mantiene un contador de FPS con requestAnimationFrame. Ese bucle es
 * intencionadamente el que reutilizaremos en la FASE 2+ para dibujar
 * detección y tracking sobre el canvas overlay, así que ya lo dejamos
 * corriendo y alineado con el vídeo desde ahora.
 */

const startScreen = document.getElementById("start-screen");
const cameraScreen = document.getElementById("camera-screen");
const startBtn = document.getElementById("start-btn");
const backBtn = document.getElementById("back-btn");
const statusEl = document.getElementById("status");
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const fpsEl = document.getElementById("fps");

let rafId = null;
let frameCount = 0;
let lastFpsSample = performance.now();

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", isError);
}

function sizeOverlayToVideo() {
  // El canvas debe tener exactamente el mismo tamaño en pantalla que
  // el <video>, en píxeles reales del dispositivo, para que cualquier
  // cosa que dibujemos encima (esquinas, homografía...) coincida con
  // lo que el usuario ve.
  const rect = video.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  overlay.width = rect.width * dpr;
  overlay.height = rect.height * dpr;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
}

function renderLoop() {
  frameCount++;
  const now = performance.now();
  const elapsed = now - lastFpsSample;

  if (elapsed >= 500) {
    const fps = Math.round((frameCount / elapsed) * 1000);
    fpsEl.textContent = `${fps} fps`;
    frameCount = 0;
    lastFpsSample = now;
  }

  // FASE 2 en adelante: aquí se llamará a la detección de la carta
  // sobre el frame actual de `video`, y se dibujará el resultado en
  // `overlay`. Por ahora el bucle solo demuestra que corre estable.

  rafId = requestAnimationFrame(renderLoop);
}

async function handleStart() {
  setStatus("Solicitando cámara…");
  startBtn.disabled = true;

  try {
    await Camera.start(video);

    startScreen.classList.add("hidden");
    cameraScreen.classList.remove("hidden");
    setStatus("");

    sizeOverlayToVideo();
    frameCount = 0;
    lastFpsSample = performance.now();
    renderLoop();
  } catch (err) {
    console.error(err);
    setStatus(err.message || "No se pudo acceder a la cámara.", true);
  } finally {
    startBtn.disabled = false;
  }
}

function handleBack() {
  if (rafId) cancelAnimationFrame(rafId);
  Camera.stop();
  cameraScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
}

window.addEventListener("resize", () => {
  if (!cameraScreen.classList.contains("hidden")) sizeOverlayToVideo();
});
window.addEventListener("orientationchange", () => {
  setTimeout(sizeOverlayToVideo, 200);
});

startBtn.addEventListener("click", handleStart);
backBtn.addEventListener("click", handleBack);
