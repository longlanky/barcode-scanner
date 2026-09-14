# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

`barcode-scanner` (v2.0.0) is a small Node.js web app for extracting **serial numbers from photos of HDD/SSD labels**. A user uploads one or more photos in the browser; the server runs a multi-engine, multi-scale barcode battery, groups hits into per-drive cards, classifies which code is the serial, shows a thumbnail of each code's source region, and offers an OCR assist fallback for labels whose barcodes are below the decodability floor. A drive with no detected serial is **not an error state** — all decoded fields are simply shown as they are (some labels carry the SN only as printed text; OCR assist covers those). The batch summary clusters confirmed serials by detected model/MPN.

There is no database, no authentication, and no build step. CPU-only by design (all decoders are classical CV; a GPU accelerates nothing here).

## Tech stack

- **Runtime:** Node.js (CommonJS, `require`/`module.exports`).
- **Server:** Express 4, in-memory uploads via `multer` (25 MB limit).
- **Image processing:** `sharp` (libvips). Images are normalized ONCE on load to a **raw 8-bit grayscale buffer** (EXIF rotation applied); every pass reads from that raw buffer — no JPEG re-encode (it measurably costs decodes) and no repeated JPEG decoding.
- **Barcode engines (ensemble):**
  - `zxing-wasm` (ZXing-C++ as WASM) — primary: Code 39/93/128, QR, **Data Matrix**, PDF417, EAN/UPC; run with `tryHarder/tryRotate/tryInvert/tryDownscale`.
  - `@undecaf/zbar-wasm` — secondary: **whole-image passes only**; empirically ZBar finds codes on full frames that it misses on crops.
- **OCR:** `tesseract.js` (WASM, no native deps) — `lib/ocr.js`, rotation(0/90/270/180) × polarity voting, sparse-text PSM 11, ~2200px working size, early exit on corroborated candidates. OCR proposals are unverified by design (misreads 8/R, 0/O on these labels) and require one-click user confirmation in the UI.
- **Frontend:** single static file `public/index.html`, inline CSS + vanilla JS.

## Repository layout

```
server.js            — Express app: /scan, /scan-region, /ocr endpoints
lib/pipeline.js      — loadNormalized (EXIF→raw gray), decodeAll battery, thumbnails
lib/classify.js      — serial/wwn/psid/part rules + per-drive spatial grouping
lib/ocr.js           — Tesseract worker singleton + voting OCR assist
public/index.html    — UI: batch upload, overview boxes, per-drive cards, OCR
                       proposals, aggregated serial list, CSV export
tools/expected.json  — hand-verified manifest of every serial/code in example photos
tools/validate.js    — validation harness (see Testing)
example_barcodes/    — real reference photos (12MP + 50MP HDD/SSD labels);
                       example_cluster_1/ = 11 in-spec single-drive close-ups
                       (Crucial, Kingston, Samsung, WD, Seagate, HGST, PNY, Mushkin)
package.json         — start script + dependencies
```

## Build and run commands

- Install: `npm install`
- Run: `npm start` → http://localhost:3010 (env `PORT` overrides)
- No build step, no linter. Tests = `tools/validate.js` (below).

## Decode pipeline (lib/pipeline.js, `decodeAll`)

1. **Whole-image fast path:** ZBar native, ZBar + `normalize()`, then ZXing on a **relative scale ladder** (1 / 0.75 / 0.5 / 0.35, capped 6000px, floored 800px) with `negate()` variants at the smaller scales. The ladder matters: a DataMatrix in the examples decodes at 0.75× but not at native or 0.5×.
2. **Deep path (native-resolution overlapping tiles, 15% overlap; 2×2, or 3×3 above 5000px):** only when `deep: 'always'` (region scans, UI "deep re-scan" button) or `'auto'` and the fast path found nothing. Empty-tile fallbacks: `negate()`, then 0.75×.
3. Results are deduped by `format|text` (formats canonicalized — ZBar `CODE128` vs ZXing `Code128`), ZXing's tighter position quad wins cross-engine duplicates, and every hit is mapped back to absolute rotated-image coordinates for boxing + thumbnailing.

Then `classify.js`: rule table (Samsung `SxxxN…` 15-char, WD `WCC…`, PNY `PNY+digits`, Mushkin `ME…`, Crucial `1###…`, Kingston `50026B…` (doubles as WWN), generic 8-char Code39→Seagate/HGST, 16-hex→WWN, 32-alnum→PSID, dash→part, URL; rules can be symbology-restricted via `formats`), **Data Matrix payload splitting** (`SN:… MPN:… PSID:…` strings → one result per field, `parsePayload`), model extraction (`extractModel`/`modelOf`: Seagate `ST…`, WD prefix, Crucial `CT…`, Samsung `MZ…`, HGST `HTS…`, PNY, Kingston, Mushkin) for per-card model and batch clustering, and spatial grouping with **serial-anchored clustering** (serials anchor drive cards; other hits attach to nearest anchor within 0.35·maxDim).

## Hard-won pitfalls (do not regress)

- **sharp reorders `extract`+`rotate` internally** → edge-region crops fail at 90/270° with "bad extract area". Materialize the crop to a buffer first (see `lib/ocr.js`).
- **`sharp(raw 1-channel).raw()` outputs 3 channels.** Always `.grayscale()` before `.raw()`, and check `info.channels` (see `toImageData`).
- **EXIF rotation:** never compute crop/extract geometry from `metadata()` of the unrotated file; `loadNormalized` rotates first and everything downstream uses rotated pixels.
- **ZBar 1D hits can have degenerate zero-size bounds** — `thumbnail()` expands them.
- Samsung labels can be **inverted** (light bars on dark) — negate variants are load-bearing. 840/850 EVO labels are often **washed out** (dark bars only reach gray ~123) — the `normalize()` whole pass is load-bearing.

## The decodability floor (capture spec, also shown in the UI)

A 15-char Code 128 SN barcode needs ≥ ~1000 px width (≈5 px/module) to decode; below ~3 px/module with camera blur, **no classical decoder or preprocessing recovers it** (verified exhaustively on the example set), and OCR reads it with char-level errors. Rule of thumb: a 2.5" drive should be ≥ ~3000 px wide in the photo → **12MP photo = 1 drive per photo; 50MP = up to 4 (2×2)**. The UI flags drives with no serial and asks for a closer retake; that flag IS correct behavior, a silent miss is a bug.

## Testing

No automated framework. `node tools/validate.js [--ocr] [--deep] [images...]` runs the pipeline over `example_barcodes/` and diffs against the hand-verified `tools/expected.json` manifest:

- Barcode path must find every serial on in-spec photos (Seagate/WD examples: 100%).
- Sub-floor serials (dense Samsung labels at 12MP) are expected via OCR proposal or a no-serial flag; `--ocr` checks the OCR path per missing serial.
- After any pipeline change, re-run and compare counts/timings. Typical: ~5s per 12MP photo, ~20s for 50MP (fast path).

Manual smoke test: `npm start`, upload a photo, check boxed overview + per-drive cards + thumbnails; drag a rectangle to exercise `/scan-region`; click "Run OCR assist" on a no-serial card.

## Security considerations

- Uploads in memory only, 25 MB cap; never written to disk or logged. The decode battery runs sharp many times per request — do not raise the cap without considering memory/CPU exhaustion.
- OCR (`tesseract.js`) keeps one warm worker; it is CPU-bound — the frontend serializes batch uploads one photo at a time for this reason.
- No auth/rate limiting: local/trusted use only; do not expose publicly without adding them.
- sharp/ZBar/ZXing error messages are returned to the client; acceptable for a local tool.

## Deployment

No CI/CD or hosting config. Install Node.js, `npm install`, `npm start` (`PORT` to change port). All barcode/OCR engines ship prebuilt WASM/binaries; no system packages or GPU required.
