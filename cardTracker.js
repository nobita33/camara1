/**
 * cardTracker.js — Estabilizador temporal (reescrito)
 *
 * La versión anterior seguía la carta con optical flow + homografía
 * encadenada, lo que acumulaba deriva. Este módulo ya NO sigue nada por
 * su cuenta: recibe en cada frame la detección ABSOLUTA de
 * cardDetector.js y su única tarea es:
 *
 *   1) mantener la identidad de las 4 esquinas entre frames aunque la
 *      carta gire (empareja por rotación cíclica con el quad anterior),
 *   2) suavizar el resultado con una media exponencial (EMA) para que
 *      no tiemble, pero SIN introducir retardo perceptible,
 *   3) "saltar" en seco cuando el candidato aparece lejos del anterior
 *      (la carta se ha reubicado, o es otra carta) en vez de
 *      interpolar por el aire,
 *   4) llevar la cuenta de frames sin detección (missStreak) y calcular
 *      una confianza 0..1 que combina la puntuación de la detección con
 *      cuántos frames seguidos lleva detectando bien.
 *
 * Como cada frame parte de una medida nueva, no hay deriva: si un frame
 * el suavizado se desvía, el siguiente lo corrige.
 */

const CardTracker = (() => {
  const ALPHA = 0.4;               // peso de la detección nueva en la EMA (0..1). Más alto = más responsivo, menos suave.
  const SNAP_DIST_RATIO = 0.5;     // salto de esquina (mediana) > esto·diagonal → reubicar, no interpolar
  const CONF_HITS_FULL = 4;        // nº de detecciones seguidas para que el término de racha llegue a 1
  const MISS_DECAY = 0.75;         // factor de caída de la confianza por cada frame sin detección (0.75 ⇒ ~3 frames de blur tolerados)

  let smoothed = null;             // { tl, tr, br, bl } en coordenadas NATIVAS
  let confidence = 0;
  let missStreak = 0;
  let hitStreak = 0;

  function clone(q) {
    return {
      tl: { x: q.tl.x, y: q.tl.y },
      tr: { x: q.tr.x, y: q.tr.y },
      br: { x: q.br.x, y: q.br.y },
      bl: { x: q.bl.x, y: q.bl.y },
    };
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function diagonal(q) {
    return Math.hypot(q.br.x - q.tl.x, q.br.y - q.tl.y);
  }

  /**
   * Empareja las esquinas del quad nuevo con las del anterior probando
   * las 4 rotaciones cíclicas (no reflexiones: conservan el sentido de
   * giro del polígono) y quedándose con la de menor error total. Así la
   * etiqueta "tl" sigue al mismo punto físico aunque la carta haya
   * girado 90° entre detecciones.
   */
  function alignToPrev(q, prev) {
    const cur = [q.tl, q.tr, q.br, q.bl];
    const ref = [prev.tl, prev.tr, prev.br, prev.bl];
    let best = 0, bestErr = Infinity;
    for (let r = 0; r < 4; r++) {
      let err = 0;
      for (let i = 0; i < 4; i++) err += dist(cur[(i + r) % 4], ref[i]);
      if (err < bestErr) { bestErr = err; best = r; }
    }
    return {
      tl: cur[best % 4],
      tr: cur[(best + 1) % 4],
      br: cur[(best + 2) % 4],
      bl: cur[(best + 3) % 4],
    };
  }

  function medianCornerJump(a, b) {
    const d = [
      dist(a.tl, b.tl), dist(a.tr, b.tr), dist(a.br, b.br), dist(a.bl, b.bl),
    ].sort((x, y) => x - y);
    return (d[1] + d[2]) / 2;
  }

  function lerpQuad(from, to, t) {
    const mix = (p, qp) => ({ x: p.x + (qp.x - p.x) * t, y: p.y + (qp.y - p.y) * t });
    return {
      tl: mix(from.tl, to.tl),
      tr: mix(from.tr, to.tr),
      br: mix(from.br, to.br),
      bl: mix(from.bl, to.bl),
    };
  }

  function reset() {
    smoothed = null;
    confidence = 0;
    missStreak = 0;
    hitStreak = 0;
  }

  /**
   * detected: { quad, score } de CardDetector.analyze(), o null si este
   * frame no hubo detección creíble.
   */
  function feed(detected) {
    if (!detected || !detected.quad) {
      missStreak++;
      hitStreak = 0;
      confidence *= MISS_DECAY;
      return { quad: smoothed, confidence, missStreak, hitStreak };
    }

    missStreak = 0;
    hitStreak++;

    if (!smoothed) {
      smoothed = clone(detected.quad);
    } else {
      const aligned = alignToPrev(detected.quad, smoothed);
      const jump = medianCornerJump(aligned, smoothed);
      const diag = diagonal(smoothed) || 1;
      if (jump > SNAP_DIST_RATIO * diag) {
        smoothed = clone(aligned); // reubicación: no interpolar por el aire
      } else {
        smoothed = lerpQuad(smoothed, aligned, ALPHA);
      }
    }

    const streakConf = Math.min(1, hitStreak / CONF_HITS_FULL);
    confidence = 0.6 * detected.score + 0.4 * streakConf;
    return { quad: smoothed, confidence, missStreak, hitStreak };
  }

  function getQuad() {
    return smoothed;
  }

  function getConfidence() {
    return confidence;
  }

  function isActive() {
    return smoothed !== null;
  }

  return { reset, feed, getQuad, getConfidence, isActive };
})();
