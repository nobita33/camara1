/**
 * cardDetector.js — Detección de carta por frame (reescrito)
 *
 * CAMBIO DE ENFOQUE respecto a la versión anterior:
 *
 * Antes: se detectaba la carta UNA vez y luego se la seguía con
 * optical flow (Lucas-Kanade) + homografía encadenada frame a frame.
 * Ese encadenado ACUMULA error: cada frame parte del cuadrilátero del
 * frame anterior, así que la estimación deriva poco a poco sobre la
 * mano o la cara y no hay forma barata de corregirla. Ese era el
 * origen del "no hace un seguimiento correcto".
 *
 * Ahora: se ejecuta una detección ABSOLUTA en CADA frame (a baja
 * resolución) y el suavizado temporal vive en cardTracker.js. Como
 * cada frame es una medida nueva e independiente, no hay deriva
 * posible: si el suavizado se equivoca, el frame siguiente lo corrige.
 *
 * ROBUSTEZ de la detección (el "a veces no detecta bien"):
 *   1) Camino principal: umbral de Otsu (separa la carta clara del
 *      fondo más oscuro) + morfología. Es estable y tiene pocos
 *      parámetros que ajustar.
 *   2) Camino de respaldo: Canny con umbral adaptado al brillo, solo
 *      si Otsu no encuentra nada — cubre el caso de fondo también
 *      claro (pared blanca) donde Otsu fusiona carta y fondo.
 *   3) Filtros de forma combinados en una PUNTUACIÓN continua en vez
 *      de una serie de "pasa / no pasa": proporción cercana a la de
 *      una carta (2.5:3.5), extent (el contorno llena su rectángulo),
 *      solidez (contorno ~ envolvente convexa), saturación baja (una
 *      carta es casi blanca; la piel y los objetos de color no) y
 *      cercanía a la posición anterior.
 *
 * Devuelve { quad, score } con quad en coordenadas de vídeo NATIVAS y
 * score 0..1, o null si en este frame no hay ningún candidato creíble.
 */

const CardDetector = (() => {
  const WORK_WIDTH = 416;          // resolución de trabajo; baja si el FPS cae mucho (p. ej. 360)

  // Rechazos duros (antes de puntuar)
  const MIN_AREA_RATIO = 0.015;    // fracción mínima del área de trabajo
  const MAX_AREA_RATIO = 0.92;     // por encima: la carta cubre casi todo el encuadre (demasiado cerca)
  // Proporción admitida. El mínimo baja de 1.08: cuando acercas la
  // carta y ROZA los bordes del frame, la parte visible deja de tener
  // proporción de carta y se acerca a un cuadrado. Un blob cuadrado,
  // muy claro, poco saturado, que llena su rectángulo y está donde ya
  // estaba la carta es, casi con seguridad, la carta recortada por el
  // borde. Los filtros de extent / solidez / saturación siguen siendo
  // el guardarraíl contra falsos positivos.
  const ASPECT_HARD_MIN = 0.60;
  const ASPECT_HARD_MAX = 3.3;     // permite inclinación/perspectiva fuerte
  const EXTENT_HARD_MIN = 0.60;
  const SAT_HARD_MAX = 175;        // 0..255; por encima de esto es claramente un objeto de color

  // Objetivos para la puntuación continua
  const ASPECT_TARGET = 1.45;      // 2.5:3.5 ≈ 1.40 ; bridge 2.25:3.5 ≈ 1.56
  const ASPECT_TOLERANCE = 0.95;
  const EXTENT_GOOD = 0.80;
  const SOLIDITY_GOOD = 0.94;
  const SAT_WHITE = 55;            // <= esto: se comporta como blanco
  const SAT_SKIN = 145;            // >= esto: se comporta como piel / color

  const TOP_N_CANDIDATES = 8;      // solo se analizan a fondo los N contornos más grandes
  const ACCEPT_SCORE = 0.42;       // puntuación mínima para dar el frame por "detectado"

  let ready = false;
  let workCanvas = null;
  let workCtx = null;
  let analyzeErrLogged = false;

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

  // ---------------------------------------------------------------
  // Geometría auxiliar
  // ---------------------------------------------------------------

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function polyArea(pts) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];
      area += p1.x * p2.y - p2.x * p1.y;
    }
    return Math.abs(area / 2);
  }

  function centroid(pts) {
    let x = 0, y = 0;
    for (const p of pts) { x += p.x; y += p.y; }
    return { x: x / pts.length, y: y / pts.length };
  }

  // RotatedRect::points() traducido de OpenCV.
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
   * Ordena 4 puntos arbitrarios como tl/tr/br/bl SIN self-intersección,
   * válido para rotaciones grandes (el método clásico por suma/resta de
   * coordenadas se rompe pasados ~35°). Método: ordenar por ángulo
   * alrededor del centroide (polígono simple garantizado), arrancar por
   * el vértice más cercano a la esquina superior-izquierda de la imagen
   * y decidir el sentido de giro con las x de los dos vecinos.
   */
  function orderQuad(pts) {
    const c = centroid(pts);
    const sorted = [...pts].sort(
      (a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x)
    );
    let start = 0, bestSum = Infinity;
    sorted.forEach((p, i) => {
      const s = p.x + p.y;
      if (s < bestSum) { bestSum = s; start = i; }
    });
    const o = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
    const tl = o[0];
    let tr, br, bl;
    if (o[1].x >= o[3].x) { tr = o[1]; br = o[2]; bl = o[3]; }
    else { tr = o[3]; br = o[2]; bl = o[1]; }
    return { tl, tr, br, bl };
  }

  function quadAspect(q) {
    const wTop = dist(q.tl, q.tr);
    const wBot = dist(q.bl, q.br);
    const hL = dist(q.tl, q.bl);
    const hR = dist(q.tr, q.br);
    const w = (wTop + wBot) / 2;
    const h = (hL + hR) / 2;
    if (w < 1 || h < 1) return null;
    return Math.max(w, h) / Math.min(w, h);
  }

  function isConvex(q) {
    const pts = [q.tl, q.tr, q.br, q.bl];
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4], cc = pts[(i + 2) % 4];
      const cross = (b.x - a.x) * (cc.y - b.y) - (b.y - a.y) * (cc.x - b.x);
      if (cross !== 0) {
        const s = Math.sign(cross);
        if (sign === 0) sign = s;
        else if (s !== sign) return false;
      }
    }
    return true;
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // ---------------------------------------------------------------
  // Extracción de 4 esquinas de un contorno
  // ---------------------------------------------------------------

  function readPts(mat, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ x: mat.data32S[i * 2], y: mat.data32S[i * 2 + 1] });
    }
    return out;
  }

  function extractQuad(contour) {
    const rrect = cv.minAreaRect(contour);
    const rArea = rrect.size.width * rrect.size.height;
    if (rArea <= 1) return null;

    const cArea = cv.contourArea(contour);
    const extent = cArea / rArea;
    if (extent < EXTENT_HARD_MIN) return null;

    const hull = new cv.Mat();
    cv.convexHull(contour, hull, false, true);
    const hullArea = cv.contourArea(hull);
    const solidity = hullArea > 0 ? cArea / hullArea : 0;

    const peri = cv.arcLength(hull, true);
    let pts = null;
    const approx = new cv.Mat();
    for (let k = 0.02; k <= 0.09 && !pts; k += 0.015) {
      cv.approxPolyDP(hull, approx, k * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) pts = readPts(approx, 4);
    }
    approx.delete();
    hull.delete();

    if (!pts) pts = rotatedRectPoints(rrect); // respaldo tolerante a esquinas redondeadas

    return { ordered: orderQuad(pts), extent, solidity };
  }

  // ---------------------------------------------------------------
  // Puntuación de un candidato
  // ---------------------------------------------------------------

  /**
   * ¿El quad toca los bordes del frame de trabajo? Si toca 2 o más
   * lados, es una vista PARCIAL de algo más grande que el encuadre
   * (típicamente la carta acercada a la cámara). En ese caso su
   * proporción visible ya no es la de una carta entera, así que no se
   * puede exigir proporción de carta.
   */
  function edgeContact(q, workW, workH) {
    const m = 3;
    const pts = [q.tl, q.tr, q.br, q.bl];
    let left = false, right = false, top = false, bottom = false;
    for (const p of pts) {
      if (p.x <= m) left = true;
      if (p.x >= workW - m) right = true;
      if (p.y <= m) top = true;
      if (p.y >= workH - m) bottom = true;
    }
    return [left, right, top, bottom].filter(Boolean).length;
  }

  function scoreCandidate(cand, workArea, workW, workH, prevQuadWork) {
    const q = cand.ordered;
    if (!isConvex(q)) return 0;

    const area = polyArea([q.tl, q.tr, q.br, q.bl]);
    const areaRatio = area / workArea;
    if (areaRatio < MIN_AREA_RATIO || areaRatio > MAX_AREA_RATIO) return 0;

    // "clipped" = vista parcial de algo mayor que el encuadre: toca 2+
    // bordes, o simplemente ocupa gran parte del frame (carta acercada
    // a la cámara, aunque por la rotación no llegue a tocar 2 bordes).
    const sidesTouched = edgeContact(q, workW, workH);
    const clipped = sidesTouched >= 2 || areaRatio > 0.45;

    const aspect = quadAspect(q);
    if (aspect === null) return 0;
    if (!clipped && (aspect < 1.05 || aspect > ASPECT_HARD_MAX)) return 0;
    if (clipped && (aspect < ASPECT_HARD_MIN || aspect > ASPECT_HARD_MAX)) return 0;

    // Una carta recortada por el borde ya no tiene por qué parecer una
    // carta de proporción; en ese caso la proporción no penaliza.
    const fAspect = clipped
      ? 0.85
      : clamp01(1 - Math.abs(aspect - ASPECT_TARGET) / ASPECT_TOLERANCE);
    const fExtent = clamp01((cand.extent - EXTENT_HARD_MIN) / (EXTENT_GOOD - EXTENT_HARD_MIN));
    const fSolidity = clamp01((cand.solidity - 0.80) / (SOLIDITY_GOOD - 0.80));
    const fArea = clamp01((areaRatio - MIN_AREA_RATIO) / (0.22 - MIN_AREA_RATIO));

    // Un candidato recortado exige extent y solidez altos (rectángulo
    // claro y sólido), porque no puede apoyarse en la proporción.
    if (clipped && (cand.extent < 0.82 || cand.solidity < 0.90)) return 0;

    let fNear = 0.5;
    if (prevQuadWork) {
      const cp = centroid([prevQuadWork.tl, prevQuadWork.tr, prevQuadWork.br, prevQuadWork.bl]);
      const cc = centroid([q.tl, q.tr, q.br, q.bl]);
      const diag = dist(prevQuadWork.tl, prevQuadWork.br) || 1;
      fNear = clamp01(1 - dist(cp, cc) / diag);
    }

    // saturación se rellena luego (necesita el frame HSV); aquí se deja
    // el hueco y se pondera fuera. Peso base sin saturación:
    const score =
      0.30 * fAspect +
      0.20 * fExtent +
      0.13 * fSolidity +
      0.12 * fArea +
      0.15 * fNear;
    // queda 0.10 para el término de saturación, que se suma después.
    return { base: score, q };
  }

  // ---------------------------------------------------------------
  // Detección principal
  // ---------------------------------------------------------------

  let lastQuad = null; // último quad NATIVO devuelto (para el término de cercanía)

  function collectContours(binMat, workArea) {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(binMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const raw = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      raw.push({ c, area: cv.contourArea(c) });
    }
    raw.sort((a, b) => b.area - a.area);

    const minRaw = workArea * MIN_AREA_RATIO * 0.4;
    const cands = [];
    for (let i = 0; i < raw.length; i++) {
      if (i < TOP_N_CANDIDATES && raw[i].area >= minRaw) {
        const q = extractQuad(raw[i].c);
        if (q) cands.push(q);
      }
      raw[i].c.delete();
    }
    contours.delete();
    hierarchy.delete();
    return cands;
  }

  function analyze(video, prevQuadNative) {
    if (!ready) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const scale = WORK_WIDTH / vw;
    const workH = Math.round(vh * scale);
    if (workCanvas.width !== WORK_WIDTH || workCanvas.height !== workH) {
      workCanvas.width = WORK_WIDTH;
      workCanvas.height = workH;
    }
    workCtx.drawImage(video, 0, 0, WORK_WIDTH, workH);

    const workArea = WORK_WIDTH * workH;
    const prevQuadWork = prevQuadNative
      ? {
          tl: { x: prevQuadNative.tl.x * scale, y: prevQuadNative.tl.y * scale },
          tr: { x: prevQuadNative.tr.x * scale, y: prevQuadNative.tr.y * scale },
          br: { x: prevQuadNative.br.x * scale, y: prevQuadNative.br.y * scale },
          bl: { x: prevQuadNative.bl.x * scale, y: prevQuadNative.bl.y * scale },
        }
      : null;

    let src, gray, hsv, blur, otsu, kernel, canny;
    let best = null; // { base, q }
    try {
      src = cv.imread(workCanvas);
      gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      hsv = new cv.Mat();
      cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
      cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

      blur = new cv.Mat();
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

      kernel = cv.Mat.ones(5, 5, cv.CV_8U);

      // --- Camino principal: Otsu ---
      otsu = new cv.Mat();
      cv.threshold(blur, otsu, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      cv.morphologyEx(otsu, otsu, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
      cv.morphologyEx(otsu, otsu, cv.MORPH_OPEN, kernel, new cv.Point(-1, -1), 1);

      let cands = collectContours(otsu, workArea);

      // --- Camino de respaldo: Canny, solo si Otsu no da nada bueno ---
      const scored1 = cands
        .map((c) => scoreCandidate(c, workArea, WORK_WIDTH, workH, prevQuadWork))
        .filter((s) => s && s.base > 0);
      let best1 = scored1.sort((a, b) => b.base - a.base)[0] || null;

      if (!best1 || best1.base < 0.5) {
        // Umbrales BAJOS y fijos (no escalados al brillo medio): este
        // camino solo se ejecuta cuando Otsu no ha encontrado nada, es
        // decir, en escenas de poco contraste carta/fondo, donde un
        // umbral alto no registraría el borde débil de la carta. El
        // cierre morfológico amplio puentea los huecos de ese borde
        // débil; el ruido que entre de más lo descartan los filtros de
        // forma (extent / solidez / proporción / saturación).
        const bigK = cv.Mat.ones(7, 7, cv.CV_8U);
        canny = new cv.Mat();
        cv.Canny(blur, canny, 30, 90);
        cv.morphologyEx(canny, canny, cv.MORPH_CLOSE, bigK, new cv.Point(-1, -1), 3);
        bigK.delete();
        const cands2 = collectContours(canny, workArea);
        const scored2 = cands2
          .map((c) => scoreCandidate(c, workArea, WORK_WIDTH, workH, prevQuadWork))
          .filter((s) => s && s.base > 0);
        const best2 = scored2.sort((a, b) => b.base - a.base)[0] || null;
        best = [best1, best2].filter(Boolean).sort((a, b) => b.base - a.base)[0] || null;
      } else {
        best = best1;
      }

      if (!best) return null;

      // --- Término de saturación sobre el mejor candidato ---
      const q = best.q;
      const maskPts = cv.matFromArray(4, 1, cv.CV_32SC2, [
        Math.round(q.tl.x), Math.round(q.tl.y),
        Math.round(q.tr.x), Math.round(q.tr.y),
        Math.round(q.br.x), Math.round(q.br.y),
        Math.round(q.bl.x), Math.round(q.bl.y),
      ]);
      const mv = new cv.MatVector();
      mv.push_back(maskPts);
      const mask = cv.Mat.zeros(hsv.rows, hsv.cols, cv.CV_8U);
      cv.fillPoly(mask, mv, new cv.Scalar(255));
      const meanHsv = cv.mean(hsv, mask);
      const meanS = meanHsv[1];
      maskPts.delete();
      mv.delete();
      mask.delete();

      if (meanS > SAT_HARD_MAX) return null;
      const fSat = clamp01((SAT_SKIN - meanS) / (SAT_SKIN - SAT_WHITE));
      const finalScore = clamp01(best.base + 0.10 * fSat);

      if (finalScore < ACCEPT_SCORE) return null;

      const inv = 1 / scale;
      const toNative = (p) => ({ x: p.x * inv, y: p.y * inv });
      lastQuad = {
        tl: toNative(q.tl),
        tr: toNative(q.tr),
        br: toNative(q.br),
        bl: toNative(q.bl),
      };
      return { quad: lastQuad, score: finalScore };
    } catch (e) {
      // Un fallo de OpenCV en un frame no debe romper el bucle; se
      // registra una sola vez para no inundar la consola si es
      // recurrente.
      if (!analyzeErrLogged) {
        analyzeErrLogged = true;
        console.warn("[CardDetector.analyze] excepción (se ignora este frame):", e);
      }
      return null;
    } finally {
      [src, gray, hsv, blur, otsu, kernel, canny].forEach((m) => m && !m.isDeleted() && m.delete());
    }
  }

  function reset() {
    lastQuad = null;
  }

  return { isReady, onScriptLoaded, analyze, orderQuad, reset };
})();
