/**
 * cardDetector.js — FASE 2
 *
 * Encuentra el contorno rectangular de una carta física en el frame
 * actual de vídeo y devuelve sus cuatro esquinas ya ordenadas
 * (tl/tr/br/bl). Técnicamente esto cubre de una vez lo que el plan
 * de fases llamaba FASE 2 (detectar el rectángulo) y FASE 3 (extraer
 * las cuatro esquinas): con contornos, approxPolyDP nos da las 4
 * esquinas en el mismo paso que detecta el rectángulo, así que
 * separarlo en dos entregas no aportaba nada real.
 *
 * Lo que esto NO hace todavía (eso es FASE 4): si en un frame no se
 * encuentra ningún contorno válido, simplemente se mantiene la última
 * posición conocida. No hay optical flow ni predicción de movimiento.
 * Por eso, si mueves la carta rápido, el indicador puede quedarse
 * "pegado" un instante hasta la siguiente detección válida.
 */

const CardDetector = (() => {
  const WORK_WIDTH = 400;        // resolución de trabajo para OpenCV; el vídeo se ve a resolución completa
  const MIN_AREA_RATIO = 0.08;   // el candidato debe ocupar al menos este % del área de trabajo
  const DETECT_INTERVAL_MS = 90; // ~11 detecciones/seg; el resto de frames reutilizan el último resultado

  let ready = false;
  let workCanvas = null;
  let workCtx = null;
  let lastDetectAt = 0;
  let lastQuad = null; // {tl,tr,br,bl} en coordenadas NATIVAS del frame de vídeo

  function isReady() {
    return ready;
  }

  function init() {
    workCanvas = document.createElement("canvas");
    workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
  }

  // Llamado desde index.html cuando el <script> de opencv.js termina de
  // descargarse. cv existe ya como objeto global, pero su runtime WASM
  // todavía tiene que terminar de inicializarse.
  function onScriptLoaded() {
    cv["onRuntimeInitialized"] = () => {
      init();
      ready = true;
      document.dispatchEvent(new CustomEvent("opencv-ready"));
    };
  }

  function orderCorners(pts) {
    // Método suma/diferencia: TL tiene la suma x+y más pequeña, BR la
    // más grande; TR tiene la diferencia x-y más pequeña, BL la más
    // grande. Es el criterio estándar y no depende del orden en que
    // approxPolyDP haya devuelto los puntos.
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

  /**
   * Analiza el frame actual de <video> y, si encuentra un candidato
   * razonable, actualiza lastQuad. Pensado para llamarse con cadencia
   * limitada (ver maybeDetect), no en cada frame del render loop.
   */
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

      edges = new cv.Mat();
      cv.Canny(blurred, edges, 50, 150);

      dilated = new cv.Mat();
      kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(edges, dilated, kernel);

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      const workArea = WORK_WIDTH * workHeight;
      let best = null;
      let bestArea = 0;

      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const perimeter = cv.arcLength(contour, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          }
          const area = quadArea(pts);
          if (area > workArea * MIN_AREA_RATIO && area > bestArea) {
            bestArea = area;
            best = pts;
          }
        }
        approx.delete();
        contour.delete();
      }

      if (best) {
        const toVideoScale = 1 / workScale;
        const scaled = best.map((p) => ({ x: p.x * toVideoScale, y: p.y * toVideoScale }));
        lastQuad = orderCorners(scaled);
      }
      // si no hay candidato válido este frame, se conserva lastQuad tal
      // cual (evita parpadeo constante); FASE 4 sustituirá esto por
      // tracking real entre detecciones.
    } finally {
      [src, gray, blurred, edges, dilated, kernel, hierarchy].forEach((m) => m && m.delete());
      if (contours) contours.delete();
    }
  }

  function maybeDetect(video, now) {
    if (now - lastDetectAt >= DETECT_INTERVAL_MS) {
      lastDetectAt = now;
      detect(video);
    }
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
