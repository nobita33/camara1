/**
 * cardTracker.js — Tracking robusto con validación continua
 *
 * Responsabilidad de este módulo: dado que ya existe una carta
 * localizada, seguirla frame a frame CON INFORMACIÓN VISUAL REAL del
 * frame actual (optical flow + homografía + comparación de contenido)
 * y devolver, además de las 4 esquinas actualizadas, una CONFIANZA
 * (0..1) de que lo que se está siguiendo sigue siendo la carta.
 *
 * Este módulo NO decide cuándo declarar la carta perdida ni cuándo
 * resetear — eso vive en app.js, que aplica histéresis sobre la
 * confianza que este módulo reporta (ver ARQUITECTURA_TRACKING.md /
 * README). cardTracker.js simplemente: cada frame, intenta seguir lo
 * mejor que puede con los datos reales del frame, y es sincero sobre
 * lo segura que está esa estimación.
 *
 * CÓMO SE CALCULA LA CONFIANZA (4 señales independientes):
 *
 * 1) inlierRatio — de los puntos que se estaban siguiendo, ¿cuántos
 *    siguen siendo consistentes con una única homografía (RANSAC)?
 *    Si la carta desaparece, la mayoría de puntos "saltan" a lo que
 *    haya detrás y dejan de ser consistentes entre sí → cae en picado.
 * 2) contentSimilarity — se recorta y RECTIFICA (perspectiva inversa)
 *    la región que se está seleccionando ahora mismo a un parche
 *    pequeño normalizado, y se compara por correlación con el parche
 *    que se capturó al iniciar el tracking. Si lo que hay bajo el
 *    cuadrilátero ha dejado de parecerse a la carta original (por
 *    ejemplo, ahora es piel de una mano o de la cara), esto se
 *    desploma — es la defensa principal contra "seguir la cara".
 * 3) lkErrorScore — el propio Lucas-Kanade devuelve un error de
 *    coincidencia por punto; si el contenido ha cambiado, ese error
 *    sube.
 * 4) geometryOk — filtro binario: convexidad, proporción ancho/alto
 *    dentro de lo plausible para una carta, y que el área no haya
 *    saltado de forma imposible respecto al frame anterior. Si falla,
 *    la confianza de ese frame es 0 directamente, sin más cálculos.
 *
 * confidence = 0.40·inlierRatio + 0.30·contentSimilarity + 0.30·lkErrorScore
 * (si geometryOk es falso, confidence = 0 sin promediar nada más)
 */

const CardTracker = (() => {
  const WORK_WIDTH = 400;
  const MIN_POINTS = 10;
  const MAX_POINTS = 60;
  const ROI_MARGIN = 4;

  const THUMB_W = 24;
  const THUMB_H = 32;

  // Límites geométricos absolutos admitidos DURANTE el tracking (algo
  // más laxos que en la detección inicial, porque aquí sí esperamos
  // perspectiva fuerte momentánea al girar/inclinar la carta).
  const ASPECT_MIN = 1.0;
  const ASPECT_MAX = 3.2;
  const AREA_JUMP_MIN = 0.35;
  const AREA_JUMP_MAX = 3.0;

  const LK_ERROR_SCALE = 18; // heurístico: error medio de LK por encima de esto → score ~0

  let workCanvas = null;
  let workCtx = null;
  let prevGray = null;
  let prevPtsMat = null;
  let refThumb = null; // cv.Mat gris, parche de referencia capturado al iniciar
  let lastVideoW = 0;
  let lastVideoH = 0;
  let tracking = false;
  let lastConfidence = 0;
  let lastMetrics = { inlierRatio: 0, contentSimilarity: 0, lkErrorScore: 0, geometryOk: false };

  function ensureCanvas() {
    if (!workCanvas) {
      workCanvas = document.createElement("canvas");
      workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
    }
  }

  function isTracking() {
    return tracking;
  }

  function getConfidence() {
    return lastConfidence;
  }

  function getMetrics() {
    return lastMetrics;
  }

  function safeDelete(m) {
    if (m && !m.isDeleted()) m.delete();
  }

  function toWorkGray(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = WORK_WIDTH / vw;
    const workHeight = Math.round(vh * scale);

    if (workCanvas.width !== WORK_WIDTH || workCanvas.height !== workHeight) {
      workCanvas.width = WORK_WIDTH;
      workCanvas.height = workHeight;
    }
    workCtx.drawImage(video, 0, 0, WORK_WIDTH, workHeight);

    const rgba = cv.imread(workCanvas);
    const gray = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    rgba.delete();
    return { gray, scale };
  }

  function nativeQuadToWork(quad, scale) {
    const conv = (p) => ({ x: p.x * scale, y: p.y * scale });
    return { tl: conv(quad.tl), tr: conv(quad.tr), br: conv(quad.br), bl: conv(quad.bl) };
  }

  function workPointToNative(p, scale) {
    return { x: p.x / scale, y: p.y / scale };
  }

  function quadArea(quad) {
    const pts = [quad.tl, quad.tr, quad.br, quad.bl];
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % 4];
      area += p1.x * p2.y - p2.x * p1.y;
    }
    return Math.abs(area / 2);
  }

  function isConvexQuad(quad) {
    const pts = [quad.tl, quad.tr, quad.br, quad.bl];
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      const c = pts[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross !== 0) {
        const s = Math.sign(cross);
        if (sign === 0) sign = s;
        else if (s !== sign) return false;
      }
    }
    return true;
  }

  function quadAspect(quad) {
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const widthTop = dist(quad.tl, quad.tr);
    const widthBottom = dist(quad.bl, quad.br);
    const heightLeft = dist(quad.tl, quad.bl);
    const heightRight = dist(quad.tr, quad.br);
    const avgWidth = (widthTop + widthBottom) / 2;
    const avgHeight = (heightLeft + heightRight) / 2;
    if (avgWidth < 1 || avgHeight < 1) return null;
    return Math.max(avgWidth, avgHeight) / Math.min(avgWidth, avgHeight);
  }

  /**
   * Filtro geométrico binario — validación explícita de "esto sigue
   * pareciendo una carta": convexo, proporción ancho/alto plausible,
   * área sin saltos imposibles respecto al frame anterior.
   */
  function geometryIsPlausible(candidate, prevArea) {
    if (!isConvexQuad(candidate)) return false;
    const aspect = quadAspect(candidate);
    if (aspect === null || aspect < ASPECT_MIN || aspect > ASPECT_MAX) return false;
    const area = quadArea(candidate);
    if (area < 4) return false;
    if (prevArea > 0) {
      const ratio = area / prevArea;
      if (ratio < AREA_JUMP_MIN || ratio > AREA_JUMP_MAX) return false;
    }
    return true;
  }

  function applyHomography(h, pt) {
    const x = h[0] * pt.x + h[1] * pt.y + h[2];
    const y = h[3] * pt.x + h[4] * pt.y + h[5];
    const w = h[6] * pt.x + h[7] * pt.y + h[8];
    return { x: x / w, y: y / w };
  }

  /**
   * Rectifica (deshace la perspectiva de) la región del quad a un
   * parche pequeño y normalizado, para poder comparar "lo que hay
   * ahí" independientemente de cómo esté rotada/inclinada la carta.
   */
  function extractRectifiedThumb(grayMat, quadWork) {
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      quadWork.tl.x, quadWork.tl.y,
      quadWork.tr.x, quadWork.tr.y,
      quadWork.br.x, quadWork.br.y,
      quadWork.bl.x, quadWork.bl.y,
    ]);
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0, THUMB_W, 0, THUMB_W, THUMB_H, 0, THUMB_H,
    ]);
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const thumb = new cv.Mat();
    cv.warpPerspective(grayMat, thumb, M, new cv.Size(THUMB_W, THUMB_H));
    srcPts.delete();
    dstPts.delete();
    M.delete();
    return thumb;
  }

  function compareToReference(grayMat, quadWork) {
    if (!refThumb) return 0;
    const current = extractRectifiedThumb(grayMat, quadWork);
    const result = new cv.Mat();
    let score = 0;
    try {
      cv.matchTemplate(current, refThumb, result, cv.TM_CCOEFF_NORMED);
      const val = result.data32F[0];
      score = Math.max(0, Math.min(1, val));
    } catch (e) {
      score = 0;
    } finally {
      current.delete();
      result.delete();
    }
    return score;
  }

  /**
   * Arranca (o reinicia) el tracking a partir de una carta recién
   * confirmada. quadNative está en coordenadas de vídeo nativas.
   */
  function start(video, quadNative) {
    ensureCanvas();
    safeDelete(prevPtsMat);
    safeDelete(prevGray);
    safeDelete(refThumb);
    prevPtsMat = null;
    prevGray = null;
    refThumb = null;
    lastConfidence = 0;

    const { gray, scale } = toWorkGray(video);
    const quadWork = nativeQuadToWork(quadNative, scale);

    const xs = [quadWork.tl.x, quadWork.tr.x, quadWork.br.x, quadWork.bl.x];
    const ys = [quadWork.tl.y, quadWork.tr.y, quadWork.br.y, quadWork.bl.y];
    const x0 = Math.max(0, Math.floor(Math.min(...xs) + ROI_MARGIN));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) + ROI_MARGIN));
    const x1 = Math.min(gray.cols, Math.ceil(Math.max(...xs) - ROI_MARGIN));
    const y1 = Math.min(gray.rows, Math.ceil(Math.max(...ys) - ROI_MARGIN));
    const roiW = Math.max(1, x1 - x0);
    const roiH = Math.max(1, y1 - y0);

    const roi = gray.roi(new cv.Rect(x0, y0, roiW, roiH));
    const corners = new cv.Mat();
    const mask = new cv.Mat();
    cv.goodFeaturesToTrack(roi, corners, MAX_POINTS, 0.01, 6, mask, 3, false, 0.04);
    mask.delete();
    roi.delete();

    if (corners.rows < MIN_POINTS) {
      corners.delete();
      gray.delete();
      tracking = false;
      return false;
    }

    const flat = [];
    for (let i = 0; i < corners.rows; i++) {
      flat.push(corners.data32F[i * 2] + x0, corners.data32F[i * 2 + 1] + y0);
    }
    corners.delete();

    prevPtsMat = cv.matFromArray(flat.length / 2, 1, cv.CV_32FC2, flat);
    refThumb = extractRectifiedThumb(gray, quadWork);
    prevGray = gray;
    lastVideoW = video.videoWidth;
    lastVideoH = video.videoHeight;
    tracking = true;
    lastConfidence = 1; // recién confirmada: confianza inicial máxima
    lastMetrics = { inlierRatio: 1, contentSimilarity: 1, lkErrorScore: 1, geometryOk: true };
    return true;
  }

  /**
   * Avanza un frame usando SOLO información visual del frame actual
   * (nunca "adivina" por posición anterior). Devuelve el quad
   * actualizado (coordenadas nativas) o null si estructuralmente ya
   * no queda nada que seguir (cero puntos). El llamador debe consultar
   * getConfidence() cada frame para decidir si mantiene o descarta el
   * resultado — este método no aplica histéresis, eso es cosa de
   * app.js.
   */
  function update(video, quadNative) {
    if (!tracking || !prevGray || !prevPtsMat || prevPtsMat.rows === 0) {
      lastConfidence = 0;
      return null;
    }

    const { gray: currGray, scale } = toWorkGray(video);
    const quadWork = nativeQuadToWork(quadNative, scale);
    const prevArea = quadArea(quadWork);
    const pointCountBefore = prevPtsMat.rows;

    const nextPts = new cv.Mat();
    const status = new cv.Mat();
    const err = new cv.Mat();
    const winSize = new cv.Size(15, 15);
    const criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 20, 0.03);

    cv.calcOpticalFlowPyrLK(prevGray, currGray, prevPtsMat, nextPts, status, err, winSize, 2, criteria);

    const prevGood = [];
    const nextGood = [];
    const errGood = [];
    for (let i = 0; i < status.rows; i++) {
      if (status.data[i] === 1) {
        prevGood.push(prevPtsMat.data32F[i * 2], prevPtsMat.data32F[i * 2 + 1]);
        nextGood.push(nextPts.data32F[i * 2], nextPts.data32F[i * 2 + 1]);
        errGood.push(err.data32F[i]);
      }
    }

    let updatedQuadWork = null;
    let inlierRatio = 0;
    let geometryOk = false;
    let lkErrorScore = 0;

    if (prevGood.length / 2 >= MIN_POINTS) {
      const meanErr = errGood.reduce((a, b) => a + b, 0) / errGood.length;
      lkErrorScore = Math.max(0, Math.min(1, 1 - meanErr / LK_ERROR_SCALE));

      const srcMat = cv.matFromArray(prevGood.length / 2, 1, cv.CV_32FC2, prevGood);
      const dstMat = cv.matFromArray(nextGood.length / 2, 1, cv.CV_32FC2, nextGood);
      const inlierMask = new cv.Mat();
      const H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 4, inlierMask);

      if (H.rows === 3 && H.cols === 3) {
        const h = Array.from(H.data64F);
        const candidate = {};
        ["tl", "tr", "br", "bl"].forEach((k) => {
          candidate[k] = applyHomography(h, quadWork[k]);
        });

        geometryOk = geometryIsPlausible(candidate, prevArea);
        if (geometryOk) updatedQuadWork = candidate;

        let inlierCount = 0;
        const inlierNext = [];
        for (let i = 0; i < inlierMask.rows; i++) {
          if (inlierMask.data[i]) {
            inlierCount++;
            inlierNext.push(nextGood[i * 2], nextGood[i * 2 + 1]);
          }
        }
        inlierRatio = inlierCount / pointCountBefore;

        // Refrescamos el set de puntos con los inliers siempre que
        // quede un mínimo razonable — así el tracking se autocorrige
        // frame a frame en vez de arrastrar outliers indefinidamente.
        if (inlierNext.length / 2 >= MIN_POINTS) {
          safeDelete(prevPtsMat);
          prevPtsMat = cv.matFromArray(inlierNext.length / 2, 1, cv.CV_32FC2, inlierNext);
        }
      }

      srcMat.delete();
      dstMat.delete();
      inlierMask.delete();
      H.delete();
    }

    // La comprobación de contenido se hace sobre la posición VIGENTE
    // (la actualizada si la geometría era plausible; si no, la de
    // partida de este frame) para saber si lo que hay ahí abajo sigue
    // pareciéndose a la carta original.
    const checkQuad = updatedQuadWork || quadWork;
    const contentSimilarity = compareToReference(currGray, checkQuad);

    safeDelete(prevGray);
    prevGray = currGray;
    lastVideoW = video.videoWidth;
    lastVideoH = video.videoHeight;

    nextPts.delete();
    status.delete();
    err.delete();

    lastMetrics = { inlierRatio, contentSimilarity, lkErrorScore, geometryOk };

    if (!geometryOk) {
      lastConfidence = 0;
      return null;
    }

    lastConfidence = 0.4 * inlierRatio + 0.3 * contentSimilarity + 0.3 * lkErrorScore;

    const conv = (p) => workPointToNative(p, scale);
    return {
      tl: conv(updatedQuadWork.tl),
      tr: conv(updatedQuadWork.tr),
      br: conv(updatedQuadWork.br),
      bl: conv(updatedQuadWork.bl),
    };
  }

  /**
   * Puntos actualmente trackeados, en coordenadas nativas — solo para
   * la capa de debug ("Mostrar tracking points").
   */
  function getDebugPointsNative() {
    if (!tracking || !prevPtsMat || !lastVideoW) return [];
    const scale = WORK_WIDTH / lastVideoW;
    const pts = [];
    for (let i = 0; i < prevPtsMat.rows; i++) {
      pts.push(workPointToNative({ x: prevPtsMat.data32F[i * 2], y: prevPtsMat.data32F[i * 2 + 1] }, scale));
    }
    return pts;
  }

  function stop() {
    safeDelete(prevPtsMat);
    safeDelete(prevGray);
    safeDelete(refThumb);
    prevPtsMat = null;
    prevGray = null;
    refThumb = null;
    tracking = false;
    lastConfidence = 0;
  }

  return { isTracking, start, update, getConfidence, getMetrics, getDebugPointsNative, stop };
})();
