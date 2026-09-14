/**
 * Decode pipeline: multi-scale, tiled, dual-engine barcode scanning.
 *
 * Strategy (validated against real HDD/SSD label photos):
 *  - coarse full-image passes at reduced size catch large/2D codes fast
 *  - overlapping native-resolution tiles catch small dense 1D barcodes
 *  - a negate() variant handles inverted (light-on-dark) labels
 *  - ZXing-WASM is the primary engine (Data Matrix, QR, 1D); ZBar is a
 *    secondary ensemble engine on tiles (occasionally wins on 1D)
 * Every result carries absolute coordinates in the EXIF-rotated image.
 */
const sharp = require('sharp');
const { readBarcodesFromImageData } = require('zxing-wasm');
const { scanImageData } = require('@undecaf/zbar-wasm');

const ZXING_FORMATS = [
  'Code128', 'Code39', 'Code93', 'Codabar', 'ITF',
  'QRCode', 'MicroQRCode', 'DataMatrix', 'PDF417', 'Aztec',
  'EAN-13', 'EAN-8', 'UPC-A', 'UPC-E',
];

/**
 * Load an upload buffer, honoring EXIF orientation, as a raw grayscale pixel
 * buffer. All passes operate on this raw buffer: no JPEG re-encode (a q92
 * re-encode measurably cost decodes on blurred labels) and no repeated JPEG
 * decoding per pass.
 */
async function loadNormalized(buffer) {
  const { data, info } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, raw: true };
}


/** sharp() source descriptor for a normalized raw buffer. */
function rawSrc(img, region = null) {
  let src = { raw: { width: img.width, height: img.height, channels: 1 } };
  if (!region) return { input: img.buffer, src, region: null };
  // Extract the region into a fresh raw buffer (sharp.extract on a raw input
  // works, but a manual crop keeps offsets trivially correct).
  const left = Math.max(0, Math.round(region.left));
  const top = Math.max(0, Math.round(region.top));
  const width = Math.min(img.width - left, Math.round(region.width));
  const height = Math.min(img.height - top, Math.round(region.height));
  if (width <= 0 || height <= 0) return { input: null, src: null, region: { left, top, width: 0, height: 0 } };
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    const start = (top + y) * img.width + left;
    img.buffer.copy(out, y * width, start, start + width);
  }
  return {
    input: out,
    src: { raw: { width, height, channels: 1 } },
    region: { left, top, width, height },
  };
}

/** Run a sharp pipeline to raw grayscale, expand to RGBA for the decoders. */
async function toImageData(pipeline) {
  // .grayscale() is required even for 1-channel raw input: sharp otherwise
  // expands raw input to 3 channels on .raw() output.
  const { data, info } = await pipeline.grayscale().raw().toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  const rgba = new Uint8ClampedArray(pixels * 4);
  if (info.channels === 1) {
    for (let i = 0, j = 0; i < pixels; i++, j += 4) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = data[i];
      rgba[j + 3] = 255;
    }
  } else {
    for (let i = 0, j = 0; i < pixels; i++, j += 4) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = data[i * info.channels];
      rgba[j + 3] = 255;
    }
  }
  return { data: rgba, width: info.width, height: info.height };
}

async function zxingDecode(imageData) {
  const results = await readBarcodesFromImageData(imageData, {
    formats: ZXING_FORMATS,
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    maxNumberOfSymbols: 64,
  });
  return results
    .filter(r => r.text && r.text.length > 0)
    .map(r => ({
      text: r.text,
      format: r.format,
      engine: 'zxing',
      points: [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft],
    }));
}

async function zbarDecode(imageData) {
  const symbols = await scanImageData(imageData);
  return symbols
    .map(s => ({ text: s.decode(), format: s.typeName.replace(/^ZBAR_/, ''), engine: 'zbar', points: s.points }))
    .filter(r => r.text && r.text.length > 0);
}

// ZBar reports CODE128, ZXing reports Code128 — canonicalize for dedupe/display.
function canonicalFormat(format) {
  const f = String(format).toLowerCase().replace(/[-_\s]/g, '');
  const names = {
    code39: 'Code39', code93: 'Code93', code128: 'Code128', codabar: 'Codabar',
    itf: 'ITF', qrcode: 'QRCode', microqrcode: 'MicroQRCode', datamatrix: 'DataMatrix',
    pdf417: 'PDF417', aztec: 'Aztec', ean13: 'EAN-13', ean8: 'EAN-8', upca: 'UPC-A', upce: 'UPC-E',
  };
  return names[f] || format;
}

/** Map a result's points from a scaled/offset pass back to absolute image coords. */
function toAbsolute(result, { scale = 1, offsetX = 0, offsetY = 0 }) {
  const pts = (result.points || []).map(p => ({ x: p.x / scale + offsetX, y: p.y / scale + offsetY }));
  return { ...result, points: pts };
}

function boundsOf(points) {
  if (!points || points.length === 0) return null;
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(Math.max(...xs) - left),
    height: Math.round(Math.max(...ys) - top),
  };
}

/**
 * Run the full decode battery on a normalized image.
 * @param {object} img - output of loadNormalized(): { buffer, width, height }
 *   where buffer is raw 8-bit grayscale pixels
 * @param {object} [region] - optional {left, top, width, height} to restrict scanning
 * @param {object} [opts] - { deep: 'auto'|'always'|'never' } controls the slow
 *   native-tile passes. 'auto' (default) runs tiles only when everything else
 *   found nothing — whole-image passes catch nearly all decodable codes and
 *   are 3-5x faster, which matters for batch use.
 * @returns {Promise<Array>} deduplicated results with absolute points/bounds
 */
async function decodeAll(img, region = null, opts = {}) {
  const deep = opts.deep || 'auto';
  let offX = 0;
  let offY = 0;
  if (region) {
    const cropped = rawSrc(img, region);
    if (!cropped.input) return [];
    img = { buffer: cropped.input, width: cropped.region.width, height: cropped.region.height };
    offX = cropped.region.left;
    offY = cropped.region.top;
  }
  const W = img.width;
  const H = img.height;

  const found = new Map(); // key: canonicalFormat|text
  const collect = (results, geo) => {
    for (const r of results) {
      const abs = toAbsolute(r, { scale: geo.scale, offsetX: geo.offsetX + offX, offsetY: geo.offsetY + offY });
      abs.format = canonicalFormat(abs.format);
      abs.text = abs.text.trim();
      const key = abs.format + '|' + abs.text;
      const prev = found.get(key);
      // Prefer ZXing's record on cross-engine duplicates: its position quads
      // are tighter (ZBar 1D hits can have degenerate zero-size bounds).
      if (!prev || (prev.engine === 'zbar' && abs.engine === 'zxing')) {
        found.set(key, { ...abs, bounds: boundsOf(abs.points), pass: geo.tag });
      }
    }
  };

  const errors = [];
  async function pass(pipeline, engines, geo) {
    try {
      const imageData = await toImageData(pipeline);
      for (const engine of engines) {
        try {
          collect(await engine(imageData), geo);
        } catch (err) {
          errors.push(`${geo.tag}/${engine.name}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`${geo.tag}: ${err.message}`);
    }
  }

  const base = () => sharp(img.buffer, { raw: { width: W, height: H, channels: 1 } });
  const maxDim = Math.max(W, H);
  const whole = { scale: 1, offsetX: 0, offsetY: 0, tag: 'whole' };

  // --- Whole-image passes (fast path) ---
  // Empirically (see tools/validate.js history): ZBar finds codes on the full
  // image that it misses on crops, so it runs whole-image only. A normalize()
  // variant recovers washed-out prints.
  await pass(base(), [zbarDecode], whole);
  await pass(base().normalize(), [zbarDecode], { ...whole, tag: 'whole-norm' });

  // ZXing runs a relative scale ladder: detection sweet spots vary per code
  // (a DataMatrix in the examples decodes at 0.75x but NOT at native or 0.5x).
  // Negated variants only at the smaller scales to bound cost.
  let prevLong = Infinity;
  for (const s of [1, 0.75, 0.5, 0.35]) {
    const scale = Math.min(s, 6000 / maxDim);
    const long = Math.round(maxDim * scale);
    if (long < 800 || long > prevLong * 0.9) continue;
    prevLong = long;
    const rw = Math.round(W * scale);
    const rh = Math.round(H * scale);
    const geo = { scale, offsetX: 0, offsetY: 0, tag: `full@${long}` };
    await pass(base().resize(rw, rh), [zxingDecode], geo);
    if (scale !== 1) {
      await pass(base().resize(rw, rh).negate(), [zxingDecode], { ...geo, tag: `full@${long}-neg` });
    }
  }

  // --- Deep path: native-resolution overlapping tiles (ZXing only) ---
  // Slow on large photos; only when asked, or when everything above missed.
  const wantTiles = deep === 'always' || (deep === 'auto' && found.size === 0);
  if (wantTiles) {
    const grid = maxDim > 5000 ? 3 : 2;
    const tw = Math.ceil(W / grid);
    const th = Math.ceil(H / grid);
    const ox = Math.ceil(tw * 0.15);
    const oy = Math.ceil(th * 0.15);
    for (let ty = 0; ty < grid; ty++) {
      for (let tx = 0; tx < grid; tx++) {
        const left = Math.max(0, tx * tw - (tx ? ox : 0));
        const top = Math.max(0, ty * th - (ty ? oy : 0));
        const width = Math.min(W - left, tw + (tx ? ox : 0) + (tx < grid - 1 ? ox : 0));
        const height = Math.min(H - top, th + (ty ? oy : 0) + (ty < grid - 1 ? oy : 0));
        const before = found.size;
        const geo = { scale: 1, offsetX: left, offsetY: top, tag: `tile${tx},${ty}` };
        await pass(base().extract({ left, top, width, height }), [zxingDecode], geo);
        // Empty tile fallbacks: inverted-label variant, then 0.75x (downscale
        // averaging pulls some blurred 2D codes over the detection threshold)
        if (found.size === before) {
          await pass(base().extract({ left, top, width, height }).negate(), [zxingDecode],
            { scale: 1, offsetX: left, offsetY: top, tag: `tile${tx},${ty}-neg` });
        }
        if (found.size === before) {
          await pass(base().extract({ left, top, width, height })
              .resize(Math.round(width * 0.75), Math.round(height * 0.75)), [zxingDecode],
            { scale: 0.75, offsetX: left, offsetY: top, tag: `tile${tx},${ty}@0.75` });
        }
      }
    }
  }

  // --- Last resort: nothing found at all -> try inverted whole-image ---
  if (found.size === 0) {
    await pass(base().negate(), [zxingDecode, zbarDecode], { scale: 1, offsetX: 0, offsetY: 0, tag: 'whole-neg' });
  }

  const results = Array.from(found.values());
  results.errors = errors;
  return results;
}

/** Extract a padded thumbnail crop for a result, as a JPEG data URI. */
async function thumbnail(img, bounds) {
  if (!bounds) return null;
  const W = img.width;
  const H = img.height;
  const b = { ...bounds };
  // ZBar 1D hits can have degenerate (zero-size) bounds — expand around center.
  if (b.width < 24) { b.left -= Math.ceil((24 - b.width) / 2); b.width = 24; }
  if (b.height < 24) { b.top -= Math.ceil((24 - b.height) / 2); b.height = 24; }
  const padX = Math.round(b.width * 0.4) + 20;
  const padY = Math.round(b.height * 0.4) + 20;
  const left = Math.max(0, b.left - padX);
  const top = Math.max(0, b.top - padY);
  const width = Math.min(W - left, b.width + 2 * padX);
  const height = Math.min(H - top, b.height + 2 * padY);
  if (width <= 0 || height <= 0) return null;
  const buf = await sharp(img.buffer, { raw: { width: W, height: H, channels: 1 } })
    .extract({ left, top, width, height })
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}

module.exports = { loadNormalized, decodeAll, thumbnail, toImageData };
