/**
 * barcode-scanner server — extract serial numbers (and all other codes) from
 * photos of HDD/SSD labels.
 *
 * POST /scan         multipart "image"                    -> full decode battery
 * POST /scan-region  multipart "image" + crop_left/top/   -> battery + OCR on one
 *                    crop_width/crop_height (rotated px)    user-selected region
 * POST /ocr          multipart "image" + crop_*           -> OCR serial proposals
 *                                                        for a drive-card region
 *
 * Access control: HTTP Basic (APP_USER / APP_PASS). If APP_PASS is unset a
 * random one is generated at boot and printed, so the service is never open.
 * Scans are CPU-bound: a global semaphore bounds concurrency and requests time
 * out rather than piling up. Deploy behind TLS (Cloudflared) — Basic sends
 * credentials with every request.
 */
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { loadNormalized, decodeAll, thumbnail } = require('./lib/pipeline');
const { classify, groupIntoCards, modelOf, parsePayload } = require('./lib/classify');
const { ocrRegion } = require('./lib/ocr');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3010;
const HOST = process.env.HOST || '127.0.0.1';

// Uploads held in memory only, capped at 25MB (decode battery runs sharp many times)
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Largest decoded image accepted. A 50MP photo is ~50MB raw + ~200MB RGBA per
// pass; this bounds peak memory when several uploads arrive at once.
const MAX_PIXELS = parseInt(process.env.MAX_PIXELS, 10) || 60 * 1000 * 1000;
// Scans are CPU-heavy; only run this many at a time and reject when saturated.
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT, 10) || 2;
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 120000;
// The "deep" tile pass is expensive. Authenticated clients may request it
// (the concurrency/timeout bounds keep it safe); set ALLOW_DEEP=0 to refuse.
const ALLOW_DEEP = process.env.ALLOW_DEEP !== '0';

// --- Access control (HTTP Basic) -------------------------------------------
let AUTH_USER = process.env.APP_USER || 'scanner';
let AUTH_PASS = process.env.APP_PASS || '';
if (!AUTH_PASS) {
  AUTH_PASS = crypto.randomBytes(12).toString('base64url');
  console.warn(
    `\n  APP_PASS was not set. Generated one for this run:\n` +
    `    user: ${AUTH_USER}\n    pass: ${AUTH_PASS}\n` +
    `  Set APP_USER/APP_PASS in the environment for a stable credential.\n`
  );
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = sep >= 0 ? decoded.slice(0, sep) : '';
    const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (safeEqual(user, AUTH_USER) && safeEqual(pass, AUTH_PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="barcode-scanner"');
  return res.status(401).json({ error: 'Authentication required' });
}

// --- Transport hardening ----------------------------------------------------
// Exactly one trusted proxy hop (cloudflared). Numeric value avoids the
// permissive `trust proxy: true` footgun.
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // data: = code thumbnails, blob: = uploaded photo previews.
      imgSrc: ["'self'", 'data:', 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      // Local/dev runs over http; do not force an https upgrade there.
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Behind Cloudflared, CF-Connecting-IP is the real client; fall back to req.ip.
const clientKey = req => req.headers['cf-connecting-ip'] || ipKeyGenerator(req.ip);
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: parseInt(process.env.RATE_LIMIT, 10) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  // trust proxy is a number (single hop); silence the permissive-proxy check
  // and the custom XFF header check (we key on CF-Connecting-IP).
  validate: { trustProxy: false, xForwardedForHeader: false },
  handler: (req, res) => res.status(429).json({ error: 'Too many requests; wait and retry.' }),
});

// Auth protects the UI and every API. Applied before static so the page is not
// served to unauthenticated clients either.
app.use(basicAuth);
app.use(express.static(path.join(__dirname, 'public')));
app.use(['/scan', '/scan-region', '/ocr'], apiLimiter);

// --- Concurrency + timeout --------------------------------------------------
let active = 0;
const waiters = [];
const MAX_WAITERS = MAX_CONCURRENT * 4;
function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(true); }
  // Bound the queue: past this point clients get 503 rather than growing
  // memory while CPU-bound scans drain.
  if (waiters.length >= MAX_WAITERS) return Promise.resolve(false);
  return new Promise(resolve => waiters.push(() => resolve(true)));
}
function release() {
  const next = waiters.shift();
  if (next) next();
  else active--;
}
async function withSlot(fn) {
  const ok = await acquire();
  if (!ok) throw Object.assign(new Error('Server busy, try again shortly.'), { status: 503 });
  try { return await fn(); } finally { release(); }
}
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { status: 504 }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function runAnalyze(fn, label) {
  return withTimeout(withSlot(fn), REQUEST_TIMEOUT_MS, label);
}

/** Reject images whose decoded pixel count would blow the memory budget. */
async function assertPixelBudget(buffer) {
  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'none' }).metadata();
  } catch {
    throw Object.assign(new Error('Unsupported or corrupt image'), { status: 400 });
  }
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) throw Object.assign(new Error('Image has no dimensions'), { status: 400 });
  if (width * height > MAX_PIXELS) {
    throw Object.assign(new Error(`Image too large (${width}x${height}); max ${MAX_PIXELS} pixels`), { status: 413 });
  }
}

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (!res.headersSent) res.status(status).json({ error: err.message });
}

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
    await assertPixelBudget(req.file.buffer);
    const deep = (ALLOW_DEEP && req.body.deep === '1') ? 'always' : 'auto';
    res.json(await runAnalyze(() => analyze(req.file.buffer, null, false, deep), 'scan'));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/scan-region', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const crop = parseCrop(req.body);
    if (!crop) return res.status(400).json({ error: 'Missing crop rectangle' });
    await assertPixelBudget(req.file.buffer);
    res.json(await runAnalyze(() => analyze(req.file.buffer, crop, true, 'always'), 'region scan'));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const crop = parseCrop(req.body);
    if (!crop) return res.status(400).json({ error: 'Missing crop rectangle' });
    await assertPixelBudget(req.file.buffer);
    const found = await runAnalyze(async () => {
      const img = await loadNormalized(req.file.buffer);
      return ocrRegion(img, crop);
    }, 'ocr');
    res.json({ candidates: found.candidates });
  } catch (err) {
    sendError(res, err);
  }
});

// JSON error handler: Multer (and anything else) must not fall through to
// Express's default HTML error page, which the frontend cannot parse.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    if (!res.headersSent) return res.status(status).json({ error: `Upload rejected: ${err.message}` });
  }
  sendError(res, err);
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  if (!ALLOW_DEEP) console.log('Deep tile scans from clients are disabled (set ALLOW_DEEP=1 to enable).');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    process.exit(1);
  }
  throw err;
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
