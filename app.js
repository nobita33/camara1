/**
 * app.js — FASE 2
 *
 * Añade a la FASE 1: llamar a CardDetector con cadencia limitada
 * dentro del render loop, mapear las coordenadas detectadas (que
 * viven en el espacio del frame de vídeo nativo) al espacio visual
 * del overlay (que sufre el recorte de `object-fit: cover` y el
 * espejado CSS), y dibujar esquinas / bounding box según el panel de
 * debug.
 */

const startScreen = document.getElementById("start-screen");
const cameraScreen = document.getElementById("camera-screen");
const startBtn = document.getElementById("start-btn");
const backBtn = document.getElementById("back-btn");
const statusEl = document.getElementById("status");
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");
const fpsEl = document.getElementById("fps");
const detectorStatusEl = document.getElementById("detector-status");

const debugToggleBtn = document.getElementById("debug-toggle-btn");
const debugPanel = document.getElementById("debug-panel");
const dbgCorners = document.getElementById("dbg-corners");
const dbgBbox = document.getElementById("dbg-bbox");
const dbgFps = document.getElementById("dbg-fps");

let rafId = null;
let frameCount = 0;
let lastFpsSample = performance.now();

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", isError);
}

function sizeOverlayToVideo() {
  const rect = video.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  overlay.width = rect.width * dpr;
  overlay.height = rect.height * dpr;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
}

/**
 * El vídeo se muestra con object-fit: cover, así que su contenido se
 * escala y recorta para llenar el elemento. Para dibujar algo que
 * coincida visualmente con un punto del frame nativo, hay que
 * reproducir esa misma transformación.
 */
function getVideoCoverTransform() {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || !rect.width || !rect.height) return null;

  const scale = Math.max(rect.width / vw, rect.height / vh);
  const offsetX = (rect.width - vw * scale) / 2;
  const offsetY = (rect.height - vh * scale) / 2;
  return { scale, offsetX, offsetY };
}

function toScreenPoint(pt, transform) {
  return {
    x: pt.x * transform.scale + transform.offsetX,
    y: pt.y * transform.scale + transform.offsetY,
  };
}

function drawOverlay(quad) {
  const dpr = window.devicePixelRatio || 1;
  const rect = video.getBoundingClientRect();

  overlayCtx.save();
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  overlayCtx.clearRect(0, 0, rect.width, rect.height);

  if (quad) {
    const transform = getVideoCoverTransform();
    if (transform) {
      const corners = ["tl", "tr", "br", "bl"].map((k) => toScreenPoint(quad[k], transform));

      if (dbgBbox.checked) {
        overlayCtx.beginPath();
        overlayCtx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < corners.length; i++) overlayCtx.lineTo(corners[i].x, corners[i].y);
        overlayCtx.closePath();
        overlayCtx.strokeStyle = "rgba(184, 57, 74, 0.9)";
        overlayCtx.lineWidth = 2;
        overlayCtx.stroke();
      }

      if (dbgCorners.checked) {
        const labels = ["TL", "TR", "BR", "BL"];
        corners.forEach((pt, i) => {
          overlayCtx.beginPath();
          overlayCtx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
          overlayCtx.fillStyle = "#ececec";
          overlayCtx.fill();

          // Contrarrestamos el espejo CSS del propio canvas al escribir
          // texto, si no las letras saldrían invertidas.
          overlayCtx.save();
          overlayCtx.translate(pt.x, pt.y - 14);
          overlayCtx.scale(-1, 1);
          overlayCtx.font = "10px -apple-system, sans-serif";
          overlayCtx.fillStyle = "rgba(236, 236, 236, 0.8)";
          overlayCtx.textAlign = "center";
          overlayCtx.fillText(labels[i], 0, 0);
          overlayCtx.restore();
        });
      }
    }
  }

  overlayCtx.restore();
}

function renderLoop() {
  const now = performance.now();

  frameCount++;
  const elapsed = now - lastFpsSample;
  if (elapsed >= 500) {
    const fps = Math.round((frameCount / elapsed) * 1000);
    fpsEl.textContent = `${fps} fps`;
    frameCount = 0;
    lastFpsSample = now;
  }
  fpsEl.classList.toggle("hidden", !dbgFps.checked);

  if (CardDetector.isReady()) {
    CardDetector.maybeDetect(video, now);
  }
  drawOverlay(CardDetector.isReady() ? CardDetector.getQuad() : null);

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
    CardDetector.reset();
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
  CardDetector.reset();
  cameraScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
}

document.addEventListener("opencv-ready", () => {
  detectorStatusEl.textContent = "";
});

window.addEventListener("resize", () => {
  if (!cameraScreen.classList.contains("hidden")) sizeOverlayToVideo();
});
window.addEventListener("orientationchange", () => {
  setTimeout(sizeOverlayToVideo, 200);
});

startBtn.addEventListener("click", handleStart);
backBtn.addEventListener("click", handleBack);
debugToggleBtn.addEventListener("click", () => debugPanel.classList.toggle("hidden"));
