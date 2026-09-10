/**
 * app.js — Bucle principal y máquina de estados (reescrito)
 *
 *   SEARCHING → DETECTING → TRACKING → LOST → SEARCHING
 *
 * Diferencia clave con la versión anterior: NO hay una fase de
 * "arranca el tracker y luego confía en él". En cada frame se ejecuta
 * una detección absoluta (CardDetector.analyze) y CardTracker solo
 * suaviza esa medida. Por eso:
 *   - no hay deriva sobre la cara / la mano,
 *   - cuando la carta desaparece de verdad, la detección deja de
 *     encontrarla y en pocos frames se pasa a LOST,
 *   - un frame suelto malo (motion blur) no rompe nada: se mantiene el
 *     último quad suavizado durante HOLD_MISS frames y se recupera solo.
 *
 * DETECTING → TRACKING exige CONFIRM_FRAMES detecciones seguidas y
 * coherentes entre sí (una sola podría ser ruido).
 */

const STATE = {
  SEARCHING: "SEARCHING",
  DETECTING: "DETECTING",
  TRACKING: "TRACKING",
  LOST: "LOST",
};

const CONFIRM_FRAMES = 2;          // detecciones seguidas y coherentes para pasar a TRACKING
const CONFIRM_DRIFT_RATIO = 0.35;  // coherencia entre detecciones consecutivas (dist centroide / diagonal)
const HOLD_MISS = 8;               // frames sin detección que se toleran antes de dar la carta por perdida
const SHOW_CONF = 0.35;            // por debajo de esto el overlay no se dibuja
const DROP_CONF = 0.30;            // confianza baja sostenida → LOST
const LOST_LABEL_MS = 500;         // cuánto se mantiene la etiqueta "LOST" en el HUD

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
const hudCardEl = document.getElementById("hud-card");
const hudTrackingEl = document.getElementById("hud-tracking");
const hudConfidenceEl = document.getElementById("hud-confidence");
const guideEl = document.getElementById("guide");

const debugToggleBtn = document.getElementById("debug-toggle-btn");
const debugPanel = document.getElementById("debug-panel");
const dbgCorners = document.getElementById("dbg-corners");
const dbgBbox = document.getElementById("dbg-bbox");
const dbgFps = document.getElementById("dbg-fps");
const dbgHomography = document.getElementById("dbg-homography");
const dbgConfidence = document.getElementById("dbg-confidence");
const dbgDigital = document.getElementById("dbg-digital");

let rafId = null;
let frameCount = 0;
let lastFpsSample = performance.now();
let opencvReady = false;

let state = STATE.SEARCHING;
let confidence = 0;
let displayQuad = null;    // quad que se dibuja este frame (o null)
let candidateQuad = null;  // detección cruda mientras se confirma
let lastRawQuad = null;
let confirmStreak = 0;
let lostUntil = 0;

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

function quadCenter(q) {
  const pts = [q.tl, q.tr, q.br, q.bl];
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / 4,
    y: pts.reduce((s, p) => s + p.y, 0) / 4,
  };
}

function quadDiagonal(q) {
  return Math.hypot(q.br.x - q.tl.x, q.br.y - q.tl.y);
}

function centerDriftRatio(a, b) {
  const ca = quadCenter(a);
  const cb = quadCenter(b);
  const d = Math.hypot(ca.x - cb.x, ca.y - cb.y);
  return d / (quadDiagonal(a) || 1);
}

// ---------------------------------------------------------------
// Render del overlay
// ---------------------------------------------------------------

function drawOverlay(quad, bboxColor, isTrackingView) {
  const dpr = window.devicePixelRatio || 1;
  const rect = video.getBoundingClientRect();

  overlayCtx.save();
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  overlayCtx.clearRect(0, 0, rect.width, rect.height);

  const transform = getVideoCoverTransform();
  if (transform && quad) {
    const corners = ["tl", "tr", "br", "bl"].map((k) => toScreenPoint(quad[k], transform));
    const cornersObj = { tl: corners[0], tr: corners[1], br: corners[2], bl: corners[3] };

    if (isTrackingView && dbgDigital.checked) {
      CardWarp.drawOnto(overlayCtx, cornersObj, rect.width, rect.height);
    }
    if (isTrackingView && dbgHomography.checked) {
      CardWarp.drawDebugGrid(overlayCtx, cornersObj, 5);
    }

    if (dbgBbox.checked) {
      overlayCtx.beginPath();
      overlayCtx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) overlayCtx.lineTo(corners[i].x, corners[i].y);
      overlayCtx.closePath();
      overlayCtx.strokeStyle = bboxColor;
      overlayCtx.lineWidth = 2.5;
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

    if (isTrackingView && dbgConfidence.checked) {
      const p = corners[0];
      overlayCtx.save();
      overlayCtx.translate(p.x, p.y - 30);
      overlayCtx.scale(-1, 1);
      overlayCtx.font = "11px -apple-system, sans-serif";
      overlayCtx.fillStyle = "rgba(236, 236, 236, 0.9)";
      overlayCtx.textAlign = "center";
      overlayCtx.fillText(confidence.toFixed(2), 0, 0);
      overlayCtx.restore();
    }
  }
  overlayCtx.restore();
}

function updateHud() {
  const cardLabel =
    state === STATE.TRACKING ? "DETECTED"
    : state === STATE.DETECTING ? "DETECTING…"
    : state === STATE.LOST ? "LOST"
    : "—";
  const trackingLabel =
    state === STATE.TRACKING
      ? (confidence >= SHOW_CONF ? "ACTIVE" : "RECOVERING")
      : "STOPPED";
  hudCardEl.textContent = `CARD: ${cardLabel}`;
  hudTrackingEl.textContent = `TRACKING: ${trackingLabel}`;
  hudConfidenceEl.textContent = state === STATE.TRACKING ? `CONFIDENCE: ${confidence.toFixed(2)}` : "";
}

// ---------------------------------------------------------------
// Máquina de estados
// ---------------------------------------------------------------

function toLost() {
  CardTracker.reset();
  CardDetector.reset();
  state = STATE.LOST;
  lostUntil = performance.now() + LOST_LABEL_MS;
  confidence = 0;
  displayQuad = null;
  candidateQuad = null;
  lastRawQuad = null;
  confirmStreak = 0;
}

function stepTracking(detected) {
  const r = CardTracker.feed(detected);
  confidence = r.confidence;

  if (!r.quad || r.missStreak > HOLD_MISS) {
    toLost();
    return;
  }
  if (confidence < DROP_CONF && r.missStreak >= 3) {
    toLost();
    return;
  }
  displayQuad = r.quad;
}

function stepSearching(detected, now) {
  if (state === STATE.LOST && now > lostUntil) state = STATE.SEARCHING;

  if (!detected) {
    confirmStreak = 0;
    lastRawQuad = null;
    candidateQuad = null;
    if (state !== STATE.LOST) state = STATE.SEARCHING;
    return;
  }

  const consistent =
    lastRawQuad && centerDriftRatio(detected.quad, lastRawQuad) < CONFIRM_DRIFT_RATIO;
  confirmStreak = consistent ? confirmStreak + 1 : 1;
  lastRawQuad = detected.quad;
  candidateQuad = detected.quad;
  state = STATE.DETECTING;

  if (confirmStreak >= CONFIRM_FRAMES) {
    CardTracker.reset();
    CardTracker.feed(detected);
    displayQuad = CardTracker.getQuad();
    confidence = CardTracker.getConfidence();
    state = STATE.TRACKING;
  }
}

function renderLoop() {
  const now = performance.now();

  frameCount++;
  const elapsed = now - lastFpsSample;
  if (elapsed >= 500) {
    fpsEl.textContent = `${Math.round((frameCount / elapsed) * 1000)} fps`;
    frameCount = 0;
    lastFpsSample = now;
  }
  fpsEl.classList.toggle("hidden", !dbgFps.checked);

  if (opencvReady && video.readyState >= 2) {
    const prev = CardTracker.getQuad();
    const detected = CardDetector.analyze(video, prev);
    if (state === STATE.TRACKING) stepTracking(detected);
    else stepSearching(detected, now);
  }

  const trackingView = state === STATE.TRACKING && confidence >= SHOW_CONF;
  const candidateView = state === STATE.DETECTING && candidateQuad;
  const quad = trackingView ? displayQuad : candidateView ? candidateQuad : null;
  const color = trackingView ? "rgba(76, 175, 118, 0.95)" : "rgba(230, 170, 60, 0.95)";

  drawOverlay(quad, color, trackingView);
  if (guideEl) guideEl.classList.toggle("hidden", trackingView);
  updateHud();

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
    CardTracker.reset();
    state = STATE.SEARCHING;
    displayQuad = null;
    candidateQuad = null;
    lastRawQuad = null;
    confirmStreak = 0;
    confidence = 0;
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
  CardTracker.reset();
  state = STATE.SEARCHING;
  displayQuad = null;
  cameraScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
}

document.addEventListener("opencv-ready", () => {
  opencvReady = true;
  detectorStatusEl.textContent = "";
});

window.addEventListener("resize", () => {
  if (!cameraScreen.classList.contains("hidden")) sizeOverlayToVideo();
});
window.addEventListener("orientationchange", () => setTimeout(sizeOverlayToVideo, 200));

startBtn.addEventListener("click", handleStart);
backBtn.addEventListener("click", handleBack);
debugToggleBtn.addEventListener("click", () => debugPanel.classList.toggle("hidden"));
