/**
 * perspective.js — FASE 5 + FASE 6 (combinadas)
 *
 * Igual que pasó con la Fase 2+3, separar "calcular la homografía"
 * (Fase 5) de "usarla para superponer una carta" (Fase 6) no tiene
 * sentido en la práctica: cv.getPerspectiveTransform +
 * cv.warpPerspective ES el mecanismo de superposición. Van juntas.
 *
 * Dada una imagen "carta digital" y las 4 esquinas de la carta física
 * en pantalla, calcula la homografía que lleva las esquinas de esa
 * imagen a esas 4 esquinas, deforma la imagen con perspectiva
 * PROYECTIVA real — nada de drawImage con escalado simple, que no
 * respeta perspectiva — y la compone sobre el overlay, solo en la
 * región que ocupa la carta (no en el canvas entero, por rendimiento).
 *
 * De momento vive detrás del checkbox de debug "Mostrar carta
 * digital": sirve para comprobar que el warp encaja bien con el
 * tracking en movimiento. El botón TRANSFORM que decide CUÁNDO se ve
 * de verdad (con animación) es la Fase 7, todavía no implementada.
 *
 * La carta que se superpone es un As de Picas generado por código
 * (sin assets externos) — un placeholder de prueba, no arte final.
 */

const CardWarp = (() => {
  let sourceCanvas = null;
  let scratch = null;

  function roundedRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function buildPlaceholderCard() {
    const c = document.createElement("canvas");
    c.width = 350;
    c.height = 490;
    const ctx = c.getContext("2d");

    ctx.fillStyle = "#f5f3ee";
    roundedRectPath(ctx, 6, 6, c.width - 12, c.height - 12, 28);
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#111111";
    roundedRectPath(ctx, 6, 6, c.width - 12, c.height - 12, 28);
    ctx.stroke();

    ctx.fillStyle = "#111111";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.font = "bold 54px -apple-system, sans-serif";
    ctx.fillText("A", 28, 24);
    ctx.font = "44px -apple-system, sans-serif";
    ctx.fillText("♠", 30, 84);

    ctx.save();
    ctx.translate(c.width - 28, c.height - 24);
    ctx.rotate(Math.PI);
    ctx.font = "bold 54px -apple-system, sans-serif";
    ctx.fillText("A", 0, 0);
    ctx.font = "44px -apple-system, sans-serif";
    ctx.fillText("♠", 2, 60);
    ctx.restore();

    ctx.font = "160px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("♠", c.width / 2, c.height / 2 + 10);

    return c;
  }

  function setSource(canvas) {
    sourceCanvas = canvas;
  }

  function getSource() {
    if (!sourceCanvas) sourceCanvas = buildPlaceholderCard();
    return sourceCanvas;
  }

  function getScratch(w, h) {
    if (!scratch) scratch = document.createElement("canvas");
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    return scratch;
  }

  /**
   * corners: {tl,tr,br,bl} en coordenadas de PANTALLA (CSS px), en el
   * mismo espacio "sin espejar" que usa el resto del overlay (el
   * mismo que ya reciben las esquinas/bounding box en app.js).
   */
  function drawOnto(overlayCtx, corners, cssWidth, cssHeight) {
    if (typeof cv === "undefined" || !cv.Mat) return;
    const source = getSource();

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
    const sw = source.width;
    const sh = source.height;

    let srcMat, srcPts, dstPts, M, warped;
    try {
      srcMat = cv.imread(source);
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
        srcMat, warped, M, new cv.Size(w, h),
        cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0)
      );

      const out = getScratch(w, h);
      cv.imshow(out, warped);

      // Contrarresta el espejo CSS del overlay, igual que con las
      // etiquetas TL/TR/BR/BL: si no, la carta digital se vería del
      // revés en pantalla.
      overlayCtx.save();
      overlayCtx.translate(x0 + w, y0);
      overlayCtx.scale(-1, 1);
      overlayCtx.drawImage(out, 0, 0);
      overlayCtx.restore();
    } finally {
      [srcMat, srcPts, dstPts, M, warped].forEach((m) => m && m.delete());
    }
  }

  return { setSource, drawOnto };
})();
