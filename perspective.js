/**
 * perspective.js — Homografía + superposición de la carta digital
 *
 * cv.getPerspectiveTransform + cv.warpPerspective ES el mecanismo de
 * superposición: una transformación proyectiva exacta sobre un canvas
 * pequeño del tamaño de la carta en pantalla.
 *
 * La imagen superpuesta es un As de Picas generado por código
 * (proporción 5:7, esquinas redondeadas, marco, índices y una pica
 * dibujada con curvas Bézier). Es una textura ÚNICA: se dibuja una vez
 * y ese canvas completo es lo que se deforma cada frame.
 *
 * Cambio respecto a la versión anterior: el cv.Mat de la textura se
 * cachea (antes se hacía cv.imread del canvas fuente en cada frame).
 */

const CardWarp = (() => {
  let sourceCanvas = null;
  let sourceMat = null;   // cv.Mat cacheado de sourceCanvas
  let scratch = null;

  // ---- construcción de la textura de la carta -------------------

  function roundedRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawSpade(ctx, cx, cy, size) {
    const w = size * 0.5;
    const h = size * 0.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy + h * 0.55);
    ctx.bezierCurveTo(cx + w * 0.05, cy + h * 0.1, cx + w, cy - h * 0.05, cx, cy - h * 0.65);
    ctx.bezierCurveTo(cx - w, cy - h * 0.05, cx - w * 0.05, cy + h * 0.1, cx, cy + h * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy + h * 0.35);
    ctx.bezierCurveTo(cx - w * 0.35, cy + h * 0.75, cx - w * 0.5, cy + h * 0.95, cx, cy + h * 0.95);
    ctx.bezierCurveTo(cx + w * 0.5, cy + h * 0.95, cx + w * 0.35, cy + h * 0.75, cx, cy + h * 0.35);
    ctx.closePath();
    ctx.fill();
  }

  function drawIndex(ctx, x, y, flip) {
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.rotate(Math.PI);
    ctx.fillStyle = "#111111";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = "bold 40px Georgia, 'Times New Roman', serif";
    ctx.fillText("A", 0, 0);
    drawSpade(ctx, 0, 34, 22);
    ctx.restore();
  }

  function buildAceOfSpades() {
    const c = document.createElement("canvas");
    c.width = 500;
    c.height = 700;
    const ctx = c.getContext("2d");
    const w = c.width;
    const h = c.height;
    const r = w * 0.055;

    ctx.fillStyle = "#fdfbf6";
    roundedRectPath(ctx, 0, 0, w, h, r);
    ctx.fill();

    ctx.lineWidth = 6;
    ctx.strokeStyle = "#161616";
    roundedRectPath(ctx, 4, 4, w - 8, h - 8, r);
    ctx.stroke();

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(20, 20, 20, 0.55)";
    roundedRectPath(ctx, 22, 22, w - 44, h - 44, r * 0.6);
    ctx.stroke();

    drawIndex(ctx, 46, 62, false);
    drawIndex(ctx, w - 46, h - 62, true);

    ctx.fillStyle = "#111111";
    drawSpade(ctx, w / 2, h / 2, w * 0.5);

    return c;
  }

  function setSource(canvas) {
    sourceCanvas = canvas;
    if (sourceMat && !sourceMat.isDeleted()) sourceMat.delete();
    sourceMat = null;
  }

  function getSource() {
    if (!sourceCanvas) sourceCanvas = buildAceOfSpades();
    return sourceCanvas;
  }

  function getSourceMat() {
    if (!sourceMat || sourceMat.isDeleted()) {
      sourceMat = cv.imread(getSource());
    }
    return sourceMat;
  }

  function getScratch(w, h) {
    if (!scratch) scratch = document.createElement("canvas");
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    return scratch;
  }

  // ---- warp + composición -----------------------------------------

  function drawOnto(overlayCtx, corners, cssWidth, cssHeight) {
    if (typeof cv === "undefined" || !cv.Mat) return;

    const pts = [corners.tl, corners.tr, corners.br, corners.bl];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const pad = 6;
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
    const x1 = Math.min(cssWidth, Math.ceil(Math.max(...xs) + pad));
    const y1 = Math.min(cssHeight, Math.ceil(Math.max(...ys) + pad));
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    if (w < 4 || h < 4) return;

    const dstRel = pts.map((p) => ({ x: p.x - x0, y: p.y - y0 }));
    const src = getSourceMat();
    const sw = src.cols;
    const sh = src.rows;

    let srcPts, dstPts, M, warped;
    try {
      srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, sw, 0, sw, sh, 0, sh]);
      dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        dstRel[0].x, dstRel[0].y,
        dstRel[1].x, dstRel[1].y,
        dstRel[2].x, dstRel[2].y,
        dstRel[3].x, dstRel[3].y,
      ]);
      M = cv.getPerspectiveTransform(srcPts, dstPts);
      warped = new cv.Mat();
      cv.warpPerspective(
        src, warped, M, new cv.Size(w, h),
        cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0)
      );

      const out = getScratch(w, h);
      cv.imshow(out, warped);

      // Contrarresta el espejo CSS del overlay (scaleX(-1)).
      overlayCtx.save();
      overlayCtx.translate(x0 + w, y0);
      overlayCtx.scale(-1, 1);
      overlayCtx.drawImage(out, 0, 0);
      overlayCtx.restore();
    } finally {
      [srcPts, dstPts, M, warped].forEach((m) => m && !m.isDeleted() && m.delete());
    }
  }

  // ---- rejilla de debug ("Mostrar homografía") --------------------

  function computeUnitSquareToQuad(corners) {
    const x0 = corners.tl.x, y0 = corners.tl.y;
    const x1 = corners.tr.x, y1 = corners.tr.y;
    const x2 = corners.br.x, y2 = corners.br.y;
    const x3 = corners.bl.x, y3 = corners.bl.y;

    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;

    let a13 = 0, a23 = 0;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
      if (Math.abs(den) > 1e-9) {
        a13 = (dx3 * dy2 - dx2 * dy3) / den;
        a23 = (dx1 * dy3 - dx3 * dy1) / den;
      }
    }
    return {
      a11: x1 - x0 + a13 * x1,
      a21: x3 - x0 + a23 * x3,
      a31: x0,
      a12: y1 - y0 + a13 * y1,
      a22: y3 - y0 + a23 * y3,
      a32: y0,
      a13, a23,
    };
  }

  function mapUnit(c, u, v) {
    const denom = c.a13 * u + c.a23 * v + 1;
    return {
      x: (c.a11 * u + c.a21 * v + c.a31) / denom,
      y: (c.a12 * u + c.a22 * v + c.a32) / denom,
    };
  }

  function drawDebugGrid(overlayCtx, corners, divisions = 5) {
    const c = computeUnitSquareToQuad(corners);
    overlayCtx.save();
    overlayCtx.strokeStyle = "rgba(120, 170, 255, 0.85)";
    overlayCtx.lineWidth = 1;
    for (let i = 0; i <= divisions; i++) {
      const t = i / divisions;
      overlayCtx.beginPath();
      for (let j = 0; j <= divisions; j++) {
        const p = mapUnit(c, t, j / divisions);
        if (j === 0) overlayCtx.moveTo(p.x, p.y);
        else overlayCtx.lineTo(p.x, p.y);
      }
      overlayCtx.stroke();
      overlayCtx.beginPath();
      for (let j = 0; j <= divisions; j++) {
        const p = mapUnit(c, j / divisions, t);
        if (j === 0) overlayCtx.moveTo(p.x, p.y);
        else overlayCtx.lineTo(p.x, p.y);
      }
      overlayCtx.stroke();
    }
    overlayCtx.restore();
  }

  return { setSource, drawOnto, drawDebugGrid };
})();
