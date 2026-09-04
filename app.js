/**
 * app.js — FASE 4
 *
 * Orquesta el ciclo completo: mientras no hay carta localizada, se
 * apoya en CardDetector (contornos) a su cadencia limitada. En cuanto
 * encuentra un candidato, arranca CardTracker (optical flow), que
 * lleva las esquinas frame a frame sin tener que re-detectar el
 * contorno. Si el tracking se pierde, se vuelve al modo búsqueda.
 *
 * Mientras se está trackeando, cada ~1.3s se lanza además una
 * detección de "control" en segundo plano: si encuentra un candidato
 * razonablemente cerca del que se está trackeando, se usa para
 * re-anclar el tracking (corrige la deriva acumulada y renueva los
 * puntos de seguimiento, que se van degradando con el tiempo).
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
const dbgTracking = document.getElementById("dbg-tracking");

const REACQUIRE_INTERVAL_MS = 1300;
const REACQUIRE_MAX_DRIFT_RATIO = 0.6; // distancia entre centros vs. tamaño del quad trackeado

let rafId = null;
let frameCount = 0;
let lastFpsSample = performance.now();
let opencvReady = false;

// 'searching' | 'tracking'
let mode = "searching";
let currentQuad = null; // último quad válido a dibujar, coords nativas
let lastReacquireAt = 0;

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

function quadCenter(quad) {
  const pts = [quad.tl, quad.tr, quad.br, quad.bl];
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / 4,
    y: pts.reduce((s, p) => s + p.y, 0) / 4,
  };
}

function quadDiagonal(quad) {
  return Math.hypot(quad.br.x - quad.tl.x, quad.br.y - quad.tl.y);
}

function drawOverlay(quad, trackingPoints) {
  const dpr = window.devicePixelRatio || 1;
  const rect = video.getBoundingClientRect();

  overlayCtx.save();
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  overlayCtx.clearRect(0, 0, rect.width, rect.height);

  const transform = getVideoCoverTransform();
  if (transform) {
    if (quad) {
      const corners = ["tl", "tr", "br", "bl"].map((k) => toScreenPoint(quad[k], transform));

      if (dbgBbox.checked) {
        overlayCtx.beginPath();
        overlayCtx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < corners.length; i++) overlayCtx.lineTo(corners[i].x, corners[i].y);
        overlayCtx.closePath();
        overlayCtx.strokeStyle = mode === "tracking" ? "rgba(76, 175, 118, 0.9)" : "rgba(184, 57, 74, 0.9)";
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

    if (dbgTracking.checked && trackingPoints && trackingPoints.length) {
      overlayCtx.fillStyle = "rgba(76, 175, 118, 0.85)";
      trackingPoints.forEach((p) => {
        const sp = toScreenPoint(p, transform);
        overlayCtx.beginPath();
        overlayCtx.arc(sp.x, sp.y, 2, 0, Math.PI * 2);
        overlayCtx.fill();
      });
    }
  }

  overlayCtx.restore();
}

function tryStartTracking(quad) {
  if (CardTracker.start(video, quad)) {
    mode = "tracking";
    currentQuad = quad;
    lastReacquireAt = performance.now();
  }
}

/**
 * Lanza una detección de contorno "de control" mientras se está
 * trackeando, y si el resultado es razonablemente coherente con lo
 * que ya se está siguiendo, re-ancla el tracking a él (corrige
 * deriva, renueva puntos de seguimiento).
 */
function maybeReacquire(now) {
  if (now - lastReacquireAt < REACQUIRE_INTERVAL_MS) return;
  lastReacquireAt = now;

  const before = CardDetector.getQuad();
  CardDetector.maybeDetect(video, now, true);
  const fresh = CardDetector.getQuad();

  if (!fresh || fresh === before || !currentQuad) return;

  const centerCurrent = quadCenter(currentQuad);
  const centerFresh = quadCenter(fresh);
  const dist = Math.hypot(centerCurrent.x - centerFresh.x, centerCurrent.y - centerFresh.y);
  const size = quadDiagonal(currentQuad);

  if (size > 0 && dist / size < REACQUIRE_MAX_DRIFT_RATIO) {
    tryStartTracking(fresh);
  }
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

  if (opencvReady) {
    if (mode === "searching") {
      CardDetector.maybeDetect(video, now);
      const quad = CardDetector.getQuad();
      if (quad) tryStartTracking(quad);
      currentQuad = quad;
      detectorStatusEl.textContent = quad ? "" : "buscando carta…";
    } else if (mode === "tracking") {
      const updated = CardTracker.update(video, currentQuad);
      if (updated) {
        currentQuad = updated;
        maybeReacquire(now);
        detectorStatusEl.textContent = "";
      } else {
        mode = "searching";
        currentQuad = null;
        detectorStatusEl.textContent = "buscando carta…";
      }
    }
  }

  drawOverlay(currentQuad, mode === "tracking" ? CardTracker.getDebugPointsNative() : null);

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
    CardTracker.stop();
    mode = "searching";
    currentQuad = null;
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
  CardTracker.stop();
  mode = "searching";
  currentQuad = null;
  cameraScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
}

document.addEventListener("opencv-ready", () => {
  opencvReady = true;
  detectorStatusEl.textContent = "buscando carta…";
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
