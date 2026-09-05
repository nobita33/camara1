/**
 * app.js — Máquina de estados de tracking
 *
 * NO_CARD → DETECTING → CARD_DETECTED → TRACKING → CARD_LOST → NO_CARD
 *
 * Esta capa (no cardTracker.js) es la que decide CUÁNDO cambiar de
 * estado, aplicando histéresis sobre la señal que le da cardTracker.js
 * (confianza 0..1 basada en datos visuales reales del frame actual —
 * ver cardTracker.js para el detalle de cómo se calcula). El overlay
 * reacciona a la confianza de forma INMEDIATA (se oculta en el mismo
 * frame en que la confianza cae por debajo del umbral); la histéresis
 * solo decide cuándo se da el tracking por completamente perdido y se
 * resetea para volver a buscar — así no hay parpadeos por un frame
 * suelto de ruido, pero tampoco se queda nada "pegado" a la cara o a
 * la mano cuando la carta física desaparece de verdad.
 *
 * DETECTING → CARD_DETECTED exige varias detecciones de contorno
 * consecutivas y razonablemente coherentes entre sí (no basta con una
 * sola, que podría ser ruido).
 */

const STATE = {
  NO_CARD: "NO_CARD",
  DETECTING: "DETECTING",
  CARD_DETECTED: "CARD_DETECTED",
  TRACKING: "TRACKING",
  CARD_LOST: "CARD_LOST",
};

const CONF_THRESHOLD = 0.5;          // por debajo de esto, el overlay se oculta YA
const LOST_STREAK_LIMIT = 3;         // frames consecutivos de baja confianza antes de resetear del todo
const DETECT_CONFIRM_FRAMES = 3;     // detecciones de contorno consecutivas y coherentes para confirmar
const DETECT_MAX_DRIFT_RATIO = 0.35; // coherencia entre detecciones consecutivas (distancia / diagonal)
const REACQUIRE_INTERVAL_MS = 1300;
const REACQUIRE_MAX_DRIFT_RATIO = 0.6;
const CARD_LOST_LABEL_MS = 450;      // cuánto se mantiene visible la etiqueta "CARD: LOST" en el HUD

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

const debugToggleBtn = document.getElementById("debug-toggle-btn");
const debugPanel = document.getElementById("debug-panel");
const dbgCorners = document.getElementById("dbg-corners");
const dbgBbox = document.getElementById("dbg-bbox");
const dbgFps = document.getElementById("dbg-fps");
const dbgTracking = document.getElementById("dbg-tracking");
const dbgHomography = document.getElementById("dbg-homography");
const dbgConfidence = document.getElementById("dbg-confidence");
const dbgDigital = document.getElementById("dbg-digital");

let rafId = null;
let frameCount = 0;
let lastFpsSample = performance.now();
let opencvReady = false;

let state = STATE.NO_CARD;
let confidence = 0;
let trackedQuad = null;    // última posición visual real mientras se trackea (se muestre o no)
let lastRawQuad = null;    // última detección de contorno cruda (para medir coherencia)
let detectStreak = 0;
let lostStreak = 0;
let cardLostUntil = 0;
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

function quadCenterDriftRatio(a, b) {
  const ca = quadCenter(a);
  const cb = quadCenter(b);
  const d = Math.hypot(ca.x - cb.x, ca.y - cb.y);
  const diag = quadDiagonal(a) || 1;
  return d / diag;
}

// ---------------------------------------------------------------
// Render del overlay
// ---------------------------------------------------------------

function drawOverlay(displayQuad, bboxColor, trackingPoints) {
  const dpr = window.devicePixelRatio || 1;
  const rect = video.getBoundingClientRect();

  overlayCtx.save();
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  overlayCtx.clearRect(0, 0, rect.width, rect.height);

  const transform = getVideoCoverTransform();
  if (transform) {
    if (displayQuad) {
      const corners = ["tl", "tr", "br", "bl"].map((k) => toScreenPoint(displayQuad[k], transform));
      const cornersObj = { tl: corners[0], tr: corners[1], br: corners[2], bl: corners[3] };

      if (dbgDigital.checked && state === STATE.TRACKING) {
        CardWarp.drawOnto(overlayCtx, cornersObj, rect.width, rect.height);
      }

      if (dbgHomography.checked && state === STATE.TRACKING) {
        CardWarp.drawDebugGrid(overlayCtx, cornersObj, 5);
      }

      if (dbgBbox.checked) {
        overlayCtx.beginPath();
        overlayCtx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < corners.length; i++) overlayCtx.lineTo(corners[i].x, corners[i].y);
        overlayCtx.closePath();
        overlayCtx.strokeStyle = bboxColor;
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

      if (dbgConfidence.checked && state === STATE.TRACKING) {
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

function updateHud() {
  const cardLabel =
    state === STATE.TRACKING || state === STATE.CARD_DETECTED ? "DETECTED"
    : state === STATE.DETECTING ? "DETECTING…"
    : state === STATE.CARD_LOST ? "LOST"
    : "—";

  const trackingLabel =
    state === STATE.TRACKING
      ? (confidence >= CONF_THRESHOLD ? "ACTIVE" : "RECOVERING")
      : "STOPPED";

  hudCardEl.textContent = `CARD: ${cardLabel}`;
  hudTrackingEl.textContent = `TRACKING: ${trackingLabel}`;
  hudConfidenceEl.textContent = state === STATE.TRACKING ? `CONFIDENCE: ${confidence.toFixed(2)}` : "";
}

// ---------------------------------------------------------------
// Máquina de estados
// ---------------------------------------------------------------

function beginTracking(video, quad) {
  if (CardTracker.start(video, quad)) {
    state = STATE.TRACKING;
    trackedQuad = quad;
    confidence = 1;
    lostStreak = 0;
    lastReacquireAt = performance.now();
    return true;
  }
  return false;
}

function resetToSearching() {
  CardTracker.stop();
  state = STATE.CARD_LOST;
  cardLostUntil = performance.now() + CARD_LOST_LABEL_MS;
  trackedQuad = null;
  lastRawQuad = null;
  confidence = 0;
  detectStreak = 0;
  lostStreak = 0;
}

/**
 * Mientras se trackea, cada ~1.3s se fuerza una detección de contorno
 * de control; si el resultado está razonablemente cerca de lo que ya
 * se sigue, se usa para "re-anclar" el tracking (corrige deriva
 * acumulada y renueva tanto los puntos de seguimiento como el parche
 * de referencia para la comprobación de contenido).
 */
function maybeReacquire(now) {
  if (now - lastReacquireAt < REACQUIRE_INTERVAL_MS) return;
  lastReacquireAt = now;

  const before = CardDetector.getQuad();
  CardDetector.maybeDetect(video, now, true);
  const fresh = CardDetector.getQuad();
  if (!fresh || fresh === before || !trackedQuad) return;

  if (quadCenterDriftRatio(trackedQuad, fresh) < REACQUIRE_MAX_DRIFT_RATIO) {
    beginTracking(video, fresh);
  }
}

function stepTracking(now) {
  const updated = CardTracker.update(video, trackedQuad);
  confidence = CardTracker.getConfidence();

  if (updated) trackedQuad = updated;

  if (updated && confidence >= CONF_THRESHOLD) {
    lostStreak = 0;
    maybeReacquire(now);
    return;
  }

  // Confianza baja (o el tracker ya no tiene nada que seguir): el
  // overlay se oculta este mismo frame (se decide en el render, más
  // abajo, comprobando confidence/estado) — aquí solo contamos
  // cuántos frames seguidos lleva así, para decidir si se resetea
  // del todo.
  lostStreak++;
  if (!updated || lostStreak >= LOST_STREAK_LIMIT) {
    resetToSearching();
  }
}

function stepSearching(now) {
  if (state === STATE.CARD_LOST && now > cardLostUntil) {
    state = STATE.NO_CARD;
  }

  const ranDetection = CardDetector.maybeDetect(video, now);
  const detected = CardDetector.getQuad();

  if (ranDetection) {
    if (detected) {
      const consistent = lastRawQuad && quadCenterDriftRatio(detected, lastRawQuad) < DETECT_MAX_DRIFT_RATIO;
      detectStreak = consistent ? detectStreak + 1 : 1;
      lastRawQuad = detected;
    } else {
      detectStreak = 0;
      lastRawQuad = null;
    }
  }

  if (!detected) {
    trackedQuad = null;
    if (state !== STATE.CARD_LOST) state = STATE.NO_CARD;
    return;
  }

  trackedQuad = detected;
  state = detectStreak >= DETECT_CONFIRM_FRAMES ? STATE.CARD_DETECTED : STATE.DETECTING;

  if (state === STATE.CARD_DETECTED) {
    if (!beginTracking(video, detected)) {
      detectStreak = 0;
      state = STATE.DETECTING;
    }
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
    if (state === STATE.TRACKING) stepTracking(now);
    else stepSearching(now);
  }

  const showTracked = state === STATE.TRACKING && confidence >= CONF_THRESHOLD;
  const showCandidate = state === STATE.DETECTING || state === STATE.CARD_DETECTED;
  const displayQuad = showTracked || showCandidate ? trackedQuad : null;
  const bboxColor = showTracked ? "rgba(76, 175, 118, 0.9)" : "rgba(230, 170, 60, 0.9)";

  drawOverlay(displayQuad, bboxColor, state === STATE.TRACKING ? CardTracker.getDebugPointsNative() : null);
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
    CardTracker.stop();
    state = STATE.NO_CARD;
    trackedQuad = null;
    lastRawQuad = null;
    detectStreak = 0;
    lostStreak = 0;
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
  CardTracker.stop();
  state = STATE.NO_CARD;
  trackedQuad = null;
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
window.addEventListener("orientationchange", () => {
  setTimeout(sizeOverlayToVideo, 200);
});

startBtn.addEventListener("click", handleStart);
backBtn.addEventListener("click", handleBack);
debugToggleBtn.addEventListener("click", () => debugPanel.classList.toggle("hidden"));
