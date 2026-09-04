/**
 * cardTracker.js — FASE 4
 *
 * Una vez que cardDetector.js ha localizado la carta, este módulo
 * evita depender de volver a detectar el contorno en cada frame:
 * sigue un puñado de puntos de interés dentro de la carta con optical
 * flow piramidal (Lucas-Kanade) y usa su desplazamiento para estimar
 * una homografía que lleva las 4 esquinas del frame anterior a su
 * posición en el frame actual.
 *
 * API pública en coordenadas de vídeo NATIVAS (igual que
 * cardDetector.js), para que app.js no tenga que preocuparse de la
 * resolución de trabajo interna de cada módulo.
 *
 * Si se pierden demasiados puntos (la carta sale de plano, se tapa,
 * cambia la luz de golpe...) el tracking se da por perdido y app.js
 * vuelve a apoyarse en cardDetector.js para readquirirla.
 */

const CardTracker = (() => {
  const WORK_WIDTH = 400;        // resolución de trabajo, independiente de la de cardDetector
  const MIN_POINTS = 10;         // por debajo de esto, tracking perdido
  const MAX_POINTS = 60;
  const ROI_MARGIN = 4;          // recorte hacia DENTRO de la carta al buscar features (evita puntos del fondo), en px de trabajo

  let workCanvas = null;
  let workCtx = null;
  let prevGray = null;
  let prevPtsMat = null;
  let lastVideoW = 0;
  let lastVideoH = 0;
  let tracking = false;

  function ensureCanvas() {
    if (!workCanvas) {
      workCanvas = document.createElement("canvas");
      workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
    }
  }

  function isTracking() {
    return tracking;
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

  /**
   * Arranca (o reinicia) el tracking a partir de una carta recién
   * detectada por cardDetector.js. quadNative está en coordenadas de
   * vídeo nativas.
   */
  function start(video, quadNative) {
    ensureCanvas();
    safeDelete(prevPtsMat);
    safeDelete(prevGray);
    prevPtsMat = null;
    prevGray = null;

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
    prevGray = gray;
    lastVideoW = video.videoWidth;
    lastVideoH = video.videoHeight;
    tracking = true;
    return true;
  }

  /**
   * Avanza un frame. Devuelve el quad actualizado (coordenadas nativas)
   * o null si el tracking se ha perdido en este frame.
   */
  function update(video, quadNative) {
    if (!tracking || !prevGray || !prevPtsMat) return null;

    const { gray: currGray, scale } = toWorkGray(video);

    const nextPts = new cv.Mat();
    const status = new cv.Mat();
    const err = new cv.Mat();
    const winSize = new cv.Size(15, 15);
    const criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 20, 0.03);

    cv.calcOpticalFlowPyrLK(prevGray, currGray, prevPtsMat, nextPts, status, err, winSize, 2, criteria);

    const prevGood = [];
    const nextGood = [];
    for (let i = 0; i < status.rows; i++) {
      if (status.data[i] === 1) {
        prevGood.push(prevPtsMat.data32F[i * 2], prevPtsMat.data32F[i * 2 + 1]);
        nextGood.push(nextPts.data32F[i * 2], nextPts.data32F[i * 2 + 1]);
      }
    }

    let updatedQuadWork = null;

    if (prevGood.length / 2 >= MIN_POINTS) {
      const srcMat = cv.matFromArray(prevGood.length / 2, 1, cv.CV_32FC2, prevGood);
      const dstMat = cv.matFromArray(nextGood.length / 2, 1, cv.CV_32FC2, nextGood);
      const inlierMask = new cv.Mat();
      const H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 4, inlierMask);

      if (H.rows === 3 && H.cols === 3) {
        const h = Array.from(H.data64F);
        const quadWork = nativeQuadToWork(quadNative, scale);
        updatedQuadWork = {};
        ["tl", "tr", "br", "bl"].forEach((k) => {
          updatedQuadWork[k] = applyHomography(h, quadWork[k]);
        });

        // Nos quedamos solo con los puntos que la homografía considera
        // inliers, para no arrastrar outliers al siguiente frame.
        const inlierNext = [];
        for (let i = 0; i < inlierMask.rows; i++) {
          if (inlierMask.data[i]) inlierNext.push(nextGood[i * 2], nextGood[i * 2 + 1]);
        }
        if (inlierNext.length / 2 >= MIN_POINTS) {
          safeDelete(prevPtsMat);
          prevPtsMat = cv.matFromArray(inlierNext.length / 2, 1, cv.CV_32FC2, inlierNext);
        } else {
          updatedQuadWork = null;
        }
      }

      srcMat.delete();
      dstMat.delete();
      inlierMask.delete();
      H.delete();
    }

    nextPts.delete();
    status.delete();
    err.delete();
    safeDelete(prevGray);
    prevGray = currGray;
    lastVideoW = video.videoWidth;
    lastVideoH = video.videoHeight;

    if (!updatedQuadWork) {
      tracking = false;
      return null;
    }

    const conv = (p) => workPointToNative(p, scale);
    return {
      tl: conv(updatedQuadWork.tl),
      tr: conv(updatedQuadWork.tr),
      br: conv(updatedQuadWork.br),
      bl: conv(updatedQuadWork.bl),
    };
  }

  function applyHomography(h, pt) {
    const x = h[0] * pt.x + h[1] * pt.y + h[2];
    const y = h[3] * pt.x + h[4] * pt.y + h[5];
    const w = h[6] * pt.x + h[7] * pt.y + h[8];
    return { x: x / w, y: y / w };
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
    prevPtsMat = null;
    prevGray = null;
    tracking = false;
  }

  return { isTracking, start, update, getDebugPointsNative, stop };
})();
