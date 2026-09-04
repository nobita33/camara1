/**
 * cardDetector.js — FASE 2 (revisado tras pruebas reales)
 *
 * Encuentra el contorno rectangular de una carta física en el frame
 * actual de vídeo y devuelve sus cuatro esquinas ya ordenadas
 * (tl/tr/br/bl), en coordenadas del frame de vídeo NATIVO.
 *
 * Revisión importante: las cartas reales tienen las esquinas
 * REDONDEADAS, no en ángulo recto. La primera versión exigía que
 * approxPolyDP encontrara exactamente 4 vértices, y ese redondeo casi
 * siempre generaba 5-8 vértices, así que la mayoría de los frames no
 * pasaban el filtro — de ahí que costara tanto detectar la carta.
 * Esta versión:
 *   1) prueba approxPolyDP con un epsilon creciente hasta simplificar
 *      a 4 vértices (absorbe el redondeo de las esquinas),
 *   2) si aun así no lo consigue, cae de vuelta a un rectángulo
 *      rotado mínimo (minAreaRect) que sí encierra cualquier forma,
 *   3) usa un umbral de Canny adaptado al brillo medio de la escena
 *      en vez de uno fijo, para no fallar con luz distinta a la de
 *      prueba,
 *   4) added un filtro de proporción (ancho/alto ~ el de una carta)
 *      para descartar falsos positivos sin penalizar demasiado el
 *      recall.
 */

const CardDetector = (() => {
  const WORK_WIDTH = 400;         // resolución de trabajo para OpenCV
  const MIN_AREA_RATIO = 0.035;   // candidato mínimo: % del área de trabajo
  const MAX_AREA_RATIO = 0.92;    // descarta "todo el encuadre" como candidato
  const ASPECT_MIN = 1.05;        // proporción lado largo/lado corto admitida
  const ASPECT_MAX = 2.4;
  const MIN_EXTENT = 0.65;        // % mínimo del rectángulo envolvente que el contorno debe rellenar
  const DETECT_INTERVAL_MS = 90;  // ~11 detecciones/seg en modo búsqueda

  let ready = false;
  let workCanvas = null;
  let workCtx = null;
  let lastDetectAt = 0;
  let lastQuad = null; // {tl,tr,br,bl} en coordenadas NATIVAS del vídeo

  function isReady() {
    return ready;
  }

  function init() {
    workCanvas = document.createElement("canvas");
    workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
  }

  function onScriptLoaded() {
    cv["onRuntimeInitialized"] = () => {
      init();
      ready = true;
      document.dispatchEvent(new CustomEvent("opencv-ready"));
    };
  }

  function orderCorners(pts) {
    const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
    const byDiff = [...pts].sort((a, b) => a.x - a.y - (b.x - b.y));
    return { tl: bySum[0], br: bySum[3], tr: byDiff[0], bl: byDiff[3] };
  }

  function quadArea(pts) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];
      area += p1.x * p2.y - p2.x * p1.y;
    }
    return Math.abs(area / 2);
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // RotatedRect::points(), traducido de OpenCV — ver rectángulo mínimo
  // rotado que encierra un contorno, como 4 puntos en orden cíclico.
  function rotatedRectPoints(rect) {
    const angle = (rect.angle * Math.PI) / 180;
    const b = Math.cos(angle) * 0.5;
    const a = Math.sin(angle) * 0.5;
    const cx = rect.center.x;
    const cy = rect.center.y;
    const w = rect.size.width;
    const h = rect.size.height;

    const p0 = { x: cx - a * h - b * w, y: cy + b * h - a * w };
    const p1 = { x: cx + a * h - b * w, y: cy - b * h - a * w };
    const p2 = { x: 2 * cx - p0.x, y: 2 * cy - p0.y };
    const p3 = { x: 2 * cx - p1.x, y: 2 * cy - p1.y };
    return [p0, p1, p2, p3];
  }

  /**
   * Dado un contorno, intenta reducirlo a 4 esquinas. Vuelve null si
   * ni approxPolyDP ni el rectángulo mínimo dan un resultado con una
   * proporción plausible de carta.
   */
  function extractQuad(contour, workArea) {
    // FILTRO CLAVE (el que faltaba): un contorno real de carta rellena
    // casi todo su rectángulo rotado mínimo (una carta es, literalmente,
    // un rectángulo). Si la dilatación ha fusionado el borde de la
    // carta con el pelo, la cara o el techo en un solo contorno grande
    // e irregular, ese contorno "llena" solo una fracción pequeña de su
    // rectángulo envolvente. Rechazarlo aquí, antes de intentar sacarle
    // 4 esquinas, es lo que evita que el sistema enganche una figura
    // gigante que abarca cara + mano + techo en vez de la carta.
    const boundingRect = cv.minAreaRect(contour);
    const boundingArea = boundingRect.size.width * boundingRect.size.height;
    const contourArea = cv.contourArea(contour);
    const extent = boundingArea > 0 ? contourArea / boundingArea : 0;
    if (extent < MIN_EXTENT) return null;

    const hull = new cv.Mat();
    cv.convexHull(contour, hull, false, true);
    const perimeter = cv.arcLength(hull, true);

    let pts = null;
    let approx = new cv.Mat();
    for (let mult = 0.02; mult <= 0.08 && !pts; mult += 0.01) {
      approx.delete();
      approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, mult * perimeter, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        pts = [];
        for (let j = 0; j < 4; j++) {
          pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
        }
      }
    }
    approx.delete();

    if (!pts) {
      // Fallback: el rectángulo rotado mínimo que ya calculamos arriba
      // para el filtro de extent. Menos fiel bajo perspectiva fuerte,
      // pero tolerante con esquinas redondeadas o bordes con ruido —
      // y ahora seguro, porque ya sabemos que el contorno rellena bien
      // ese rectángulo.
      pts = rotatedRectPoints(boundingRect);
    }
    hull.delete();

    const area = quadArea(pts);
    if (area < workArea * MIN_AREA_RATIO || area > workArea * MAX_AREA_RATIO) return null;

    const ordered = orderCorners(pts);
    const widthTop = dist(ordered.tl, ordered.tr);
    const widthBottom = dist(ordered.bl, ordered.br);
    const heightLeft = dist(ordered.tl, ordered.bl);
    const heightRight = dist(ordered.tr, ordered.br);
    const avgWidth = (widthTop + widthBottom) / 2;
    const avgHeight = (heightLeft + heightRight) / 2;
    if (avgWidth < 1 || avgHeight < 1) return null;

    const aspect = Math.max(avgWidth, avgHeight) / Math.min(avgWidth, avgHeight);
    if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) return null;

    return { ordered, area };
  }

  function autoCannyThresholds(grayMat) {
    // Aproximación barata de "auto canny": en vez de un 50/150 fijo,
    // centra los umbrales en el brillo medio de la escena para que
    // funcione tanto con luz intensa como tenue.
    const mean = cv.mean(grayMat)[0];
    return {
      lower: Math.max(0, 0.66 * mean),
      upper: Math.min(255, 1.33 * mean),
    };
  }

  function detect(video) {
    if (!ready) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    const workScale = WORK_WIDTH / vw;
    const workHeight = Math.round(vh * workScale);

    if (workCanvas.width !== WORK_WIDTH || workCanvas.height !== workHeight) {
      workCanvas.width = WORK_WIDTH;
      workCanvas.height = workHeight;
    }
    workCtx.drawImage(video, 0, 0, WORK_WIDTH, workHeight);

    let src, gray, blurred, edges, dilated, kernel, contours, hierarchy;
    try {
      src = cv.imread(workCanvas);
      gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

      const { lower, upper } = autoCannyThresholds(blurred);
      edges = new cv.Mat();
      cv.Canny(blurred, edges, lower, upper);

      dilated = new cv.Mat();
      kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 1);

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const workArea = WORK_WIDTH * workHeight;
      let best = null;
      let bestArea = 0;

      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const result = extractQuad(contour, workArea);
        contour.delete();
        if (result && result.area > bestArea) {
          bestArea = result.area;
          best = result.ordered;
        }
      }

      if (best) {
        const toVideoScale = 1 / workScale;
        const scalePoint = (p) => ({ x: p.x * toVideoScale, y: p.y * toVideoScale });
        lastQuad = {
          tl: scalePoint(best.tl),
          tr: scalePoint(best.tr),
          br: scalePoint(best.br),
          bl: scalePoint(best.bl),
        };
      }
      // si no hay candidato válido este frame, se conserva lastQuad
    } finally {
      [src, gray, blurred, edges, dilated, kernel, hierarchy].forEach((m) => m && m.delete());
      if (contours) contours.delete();
    }
  }

  function maybeDetect(video, now, force = false) {
    if (force || now - lastDetectAt >= DETECT_INTERVAL_MS) {
      lastDetectAt = now;
      detect(video);
      return true;
    }
    return false;
  }

  function getQuad() {
    return lastQuad;
  }

  function reset() {
    lastQuad = null;
    lastDetectAt = 0;
  }

  return { isReady, onScriptLoaded, maybeDetect, getQuad, reset };
})();
