/**
 * barcode-scanner server — extract serial numbers (and all other codes) from
 * photos of HDD/SSD labels.
 *
 * POST /scan         multipart "image"                    -> full decode battery
 * POST /scan-region  multipart "image" + crop_left/top/   -> battery + OCR on one
 *                    crop_width/crop_height (rotated px)    user-selected region
 * POST /ocr          multipart "image" + crop_*           -> OCR serial proposals
 *                                                        for a drive-card region
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const { loadNormalized, decodeAll, thumbnail } = require('./lib/pipeline');
const { classify, groupIntoCards, modelOf, parsePayload } = require('./lib/classify');
const { ocrRegion } = require('./lib/ocr');

const app = express();
const PORT = process.env.PORT || 3010;

// Uploads held in memory only, capped at 25MB (decode battery runs sharp many times)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function parseCrop(body) {
  if (!body.crop_width || !body.crop_height) return null;
  return {
    left: parseInt(body.crop_left, 10) || 0,
    top: parseInt(body.crop_top, 10) || 0,
    width: parseInt(body.crop_width, 10),
    height: parseInt(body.crop_height, 10),
  };
}

/** Decode + classify + group + thumbnail. Shared by /scan and /scan-region. */
async function analyze(imageBuffer, region = null, withOcr = false, deep = 'auto') {
  const t0 = Date.now();
  const img = await loadNormalized(imageBuffer);
  const { width, height } = img;

  const raw = await decodeAll(img, region, { deep });
  const results = [];
  const pushResult = (r, overrides = {}) => {
    const { kind, make } = overrides.kind
      ? { kind: overrides.kind, make: overrides.make || null }
      : classify(r.text, r.format);
    results.push({
      id: results.length,
      text: r.text,
      format: r.format,
      engine: r.engine,
      source: 'barcode',
      kind,
      make,
      bounds: r.bounds,
      points: r.points,
      thumb: overrides.thumb !== undefined ? overrides.thumb : undefined,
      via: overrides.via || null,
    });
  };
  for (const r of raw) {
    const thumb = await thumbnail(img, r.bounds);
    // Structured payloads (e.g. Crucial "SN:... MPN:... PSID:..." Data Matrix)
    // are split so every field shows and classifies as its own value.
    const fields = parsePayload(r.text);
    if (fields) {
      for (const f of fields) {
        pushResult(
          { ...r, text: f.value },
          { kind: f.kind || undefined, thumb, via: `${r.format} payload (${f.field})` }
        );
      }
    } else {
      pushResult(r, { thumb });
    }
  }

  // Region scans are user-targeted: always offer OCR proposals there.
  // OCR failure must not sink the barcode results.
  const ocr = { candidates: [] };
  if (withOcr && region) {
    try {
      const found = await ocrRegion(img, region);
      ocr.candidates = found.candidates
        .filter(c => !results.some(r => r.text === c.value))
        .map(c => ({ ...c, source: 'ocr' }));
    } catch (err) {
      console.error('OCR stage error:', err.message);
    }
  }

  const cards = groupIntoCards(results, width, height).map((c, i) => ({
    id: i,
    itemIds: c.items.map(r => r.id),
    serialId: c.serial ? c.serial.id : null,
    bounds: c.bounds,
    status: c.status,
    model: modelOf(c.items),
  }));

  return {
    width, height, region,
    results, cards,
    ocrCandidates: ocr.candidates,
    suggestOcr: cards.some(c => c.status === 'no-serial'),
    deepRan: deep === 'always' || (deep === 'auto' && raw.length === 0),
    elapsedMs: Date.now() - t0,
  };
}

app.post('/scan', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const deep = req.body.deep === '1' ? 'always' : 'auto';
    res.json(await analyze(req.file.buffer, null, false, deep));
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/scan-region', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const crop = parseCrop(req.body);
    if (!crop) return res.status(400).json({ error: 'Missing crop rectangle' });
    res.json(await analyze(req.file.buffer, crop, true, 'always'));
  } catch (err) {
    console.error('Region scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const crop = parseCrop(req.body);
    if (!crop) return res.status(400).json({ error: 'Missing crop rectangle' });
    const img = await loadNormalized(req.file.buffer);
    const found = await ocrRegion(img, crop);
    res.json({ candidates: found.candidates });
  } catch (err) {
    console.error('OCR error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
