/**
 * OCR assist: last-resort serial-number reader for barcodes that are below
 * the decodability floor (too small/blurred). Reads the human-readable
 * "S/N: ..." text printed next to the barcode instead.
 *
 * Labels may be rotated any direction and printed light-on-dark, so every
 * region is read under 4 rotations x 2 polarities; candidates are merged by
 * majority vote across variants. Proposals are ALWAYS unverified — OCR
 * misreads characters on these labels (8/R, 0/O), so the UI requires the
 * user to confirm against the photo.
 */
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const { classify } = require('./classify');

let workerPromise = null;
/**
 * Lazily create and reuse one Tesseract worker (language load is slow).
 * A rejected init must NOT be cached: otherwise one transient failure (e.g.
 * the first-run traineddata fetch) permanently breaks OCR until restart.
 */
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng').then(async w => {
      await w.setParameters({ tessedit_pageseg_mode: '11' }); // sparse text
      return w;
    }).catch(err => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

// Candidate patterns: context-first ("S/N: X"), then known serial shapes.
const CONTEXT_RE = /(?:S\s*[\/\\.,]?\s*N|SERIAL)\s*[:.]?\s*([A-Z0-9]{8,20})\b/g;
const SHAPE_RES = [
  /\bS[A-Z0-9]{3}N[A-Z0-9]{9,12}\b/g,  // Samsung (15 chars: S + 3 + N + 10)
  /\bW[A-Z]{2}[A-Z0-9]{9}\b/g,          // WD
  /\bZ[A-Z0-9]{7}\b/g,                  // Seagate
];

function extractCandidates(text, into) {
  const clean = text.toUpperCase().replace(/[^A-Z0-9\s:\/\\.,-]/g, ' ');
  for (const m of clean.matchAll(CONTEXT_RE)) {
    const v = m[1].replace(/[^A-Z0-9]/g, '');
    if (v.length >= 8 && v.length <= 20) into.add(v);
  }
  for (const re of SHAPE_RES) {
    for (const m of clean.matchAll(re)) into.add(m[0]);
  }
}

/**
 * OCR a region of the normalized image with rotation/polarity voting.
 * @param {object} img - output of pipeline.loadNormalized() (raw grayscale)
 * @returns {Promise<{candidates: Array<{value, votes, confidence}>}>}
 */
async function ocrRegion(img, rect) {
  // Pad the region: tight crops starve Tesseract's layout analysis of context.
  const padX = Math.round(rect.width * 0.25);
  const padY = Math.round(rect.height * 0.25);
  const left = Math.max(0, Math.round(rect.left) - padX);
  const top = Math.max(0, Math.round(rect.top) - padY);
  const width = Math.min(img.width - left, Math.round(rect.width) + 2 * padX);
  const height = Math.min(img.height - top, Math.round(rect.height) + 2 * padY);
  if (width <= 0 || height <= 0) return { candidates: [] };
  const src = () => sharp(img.buffer, { raw: { width: img.width, height: img.height, channels: 1 } });

  // Materialize the crop first: sharp reorders extract/rotate internally,
  // which breaks edge-region crops at 90/270 degrees.
  const cropBuf = await src().extract({ left, top, width, height }).png().toBuffer();

  // Tesseract time grows with pixel count, so every region is scaled to a
  // common working size. 3200px measured as the sweet spot: smaller drops
  // 25-30px label text below reliable recognition, bigger just costs time.
  const longSide = Math.max(width, height);
  const scale = Math.min(3, 3200 / longSide);

  const votes = new Map(); // value -> { votes, confidence }
  let ran = 0;
  // rot 0 first (most photos are axis-aligned); early-exit once a candidate
  // is corroborated by several independent reads.
  outer:
  for (const rot of [0, 90, 270, 180]) {
    for (const polarity of ['plain', 'neg']) {
      let p = sharp(cropBuf).rotate(rot);
      const rw = rot % 180 === 0 ? width : height;
      if (Math.abs(scale - 1) > 0.01) p = p.resize(Math.round(rw * scale), null, { kernel: 'lanczos3' });
      p = p.normalize();
      if (polarity === 'neg') p = p.negate();
      const buf = await p.png().toBuffer();
      let worker;
      try {
        worker = await getWorker();
      } catch (err) {
        // Language/worker could not be initialized; no point retrying variants.
        console.error('OCR worker init error:', err.message);
        break outer;
      }
      let data;
      try {
        ({ data } = await worker.recognize(buf));
      } catch (err) {
        // A wedged worker must not poison the cache: drop it and continue.
        workerPromise = null;
        try { await worker.terminate(); } catch { /* already dead */ }
        continue;
      }
      ran++;
      const conf = typeof data.confidence === 'number' ? data.confidence : 0;
      const hits = new Set();
      extractCandidates(data.text, hits);
      for (const v of hits) {
        const cur = votes.get(v) || { votes: 0, confidence: 0 };
        cur.votes += 1;
        cur.confidence = Math.max(cur.confidence, Math.round(conf));
        votes.set(v, cur);
        if (cur.votes >= 3 || (cur.votes >= 2 && cur.confidence >= 60)) break outer;
      }
    }
  }
  const candidates = Array.from(votes, ([value, s]) => ({ value, votes: s.votes, of: ran, confidence: s.confidence }))
    // Trust filter: a candidate must look like a known serial format, or be
    // corroborated by multiple confident reads. Single low-confidence junk
    // reads of barcode bars/PSID lines are dropped.
    .filter(c => classify(c.value, '').kind === 'serial' || (c.votes >= 2 && c.confidence >= 60))
    .sort((a, b) => b.votes - a.votes || b.confidence - a.confidence);
  return { candidates };
}

module.exports = { ocrRegion };
