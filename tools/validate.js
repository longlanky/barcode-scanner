/**
 * Validation harness: runs the decode pipeline over example_barcodes/ and
 * diffs against the hand-verified manifest in expected.json.
 *
 * Usage: node tools/validate.js [image.jpg ...]
 * Exit code 0 = every expected serial was found via barcodes, or was
 * correctly accounted for (image reported its drives with no silent miss).
 */
const fs = require('fs');
const path = require('path');
const { loadNormalized, decodeAll } = require('../lib/pipeline');
const { classify, groupIntoCards, parsePayload } = require('../lib/classify');

const DIR = path.join(__dirname, '..', 'example_barcodes');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected.json'), 'utf8'));
const WITH_OCR = process.argv.includes('--ocr');
const WITH_DEEP = process.argv.includes('--deep');

async function runImage(file) {
  const t0 = Date.now();
  const img = await loadNormalized(fs.readFileSync(path.join(DIR, file)));
  const raw = await decodeAll(img, null, { deep: WITH_DEEP ? 'always' : 'auto' });
  // Mirror server.js: split structured payloads (SN:/MPN:/PSID:) into fields.
  const expanded = [];
  for (const r of raw) {
    const fields = parsePayload(r.text);
    if (fields) {
      for (const f of fields) expanded.push({ ...r, text: f.value });
    } else {
      expanded.push(r);
    }
  }
  const results = expanded.map(r => ({ ...r, ...classify(r.text, r.format) }));
  const cards = groupIntoCards(results, img.width, img.height);
  return { img, results, cards, elapsedMs: Date.now() - t0 };
}

(async () => {
  // Self-check: every manifest serial must classify as kind 'serial' under at
  // least one common symbology (a rule regression would silently mislabel
  // real hits in the UI).
  let rulesOk = true;
  for (const [file, exp] of Object.entries(manifest.images)) {
    for (const s of exp.serials) {
      const kinds = ['Code39', 'Code128', 'DataMatrix'].map(f => classify(s.value, f).kind);
      if (!kinds.includes('serial')) {
        rulesOk = false;
        console.log(`RULE BUG: ${s.value} (${file}) classifies as '${kinds[0]}', expected 'serial'`);
      }
    }
    // Non-serial codes must never be promoted to a serial: a false positive is
    // worse than a miss (it shows up as a verified serial in the UI).
    for (const c of exp.otherCodes || []) {
      const kinds = ['Code39', 'Code128', 'DataMatrix'].map(f => classify(c, f).kind);
      if (kinds.includes('serial')) {
        rulesOk = false;
        console.log(`FALSE POSITIVE: ${c} (${file}) classifies as 'serial', expected non-serial`);
      }
    }
  }
  if (!rulesOk) process.exit(2);

  const requested = process.argv.slice(2).filter(a => !a.startsWith('--'));
  let allOk = true;
  // Accept both manifest basenames and real paths (e.g. example_barcodes/x.jpg).
  const toRun = requested.length
    ? requested.map(arg => {
        if (manifest.images[arg]) return arg;
        const base = path.basename(arg);
        if (manifest.images[base]) return base;
        console.log(`?? ${arg}: not in manifest`);
        allOk = false;
        return null;
      }).filter(Boolean)
    : Object.keys(manifest.images);
  for (const file of toRun) {
    const expected = manifest.images[file];
    if (!expected) { console.log(`?? ${file}: not in manifest`); continue; }
    const { img, results, cards, elapsedMs } = await runImage(file);
    const texts = new Set(results.map(r => r.text));
    const serialsFound = expected.serials.filter(s => texts.has(s.value));
    let serialsMissing = expected.serials.filter(s => !texts.has(s.value));

    // OCR assist path: for serials the barcode battery missed, OCR their label
    // region (same operation the UI offers via "Run OCR assist").
    const ocrNotes = [];
    if (WITH_OCR && serialsMissing.length) {
      const { ocrRegion } = require('../lib/ocr');
      for (const s of serialsMissing) {
        if (!s.labelRect) { ocrNotes.push(`${s.value}: no labelRect`); continue; }
        const [left, top, w, h] = s.labelRect;
        const { candidates } = await ocrRegion(img, { left, top, width: w, height: h });
        const hit = candidates.find(c => c.value === s.value);
        if (hit) {
          ocrNotes.push(`${s.value}: OCR OK (${hit.votes}/${hit.of} reads, conf ${hit.confidence})`);
          serialsMissing = serialsMissing.filter(x => x !== s);
        } else {
          const near = candidates.slice(0, 2).map(c => `${c.value}(${c.votes}/${c.of})`).join(' ');
          ocrNotes.push(`${s.value}: OCR miss${near ? ' (saw ' + near + ')' : ''}`);
        }
      }
    }

    // Below-floor serials (marked in the manifest) are expected NOT to decode
    // in these photos; the app's retake/OCR path is the correct behavior.
    const hardMisses = serialsMissing.filter(s => !s.belowFloor);
    const floorMisses = serialsMissing.filter(s => s.belowFloor);
    const ok = hardMisses.length === 0;
    allOk = allOk && ok;
    console.log(`\n${ok ? 'PASS' : 'FAIL'} ${file} — ${results.length} codes, ` +
      `${cards.length} cards, ${cards.filter(c => c.status === 'no-serial').length} no-serial, ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log(`  serials: ${serialsFound.length}/${expected.serials.length} via barcode`);
    for (const n of ocrNotes) console.log(`  ocr: ${n}`);
    if (floorMisses.length) {
      console.log(`  below floor (retake/OCR path expected): ${floorMisses.map(s => s.value).join(', ')}`);
    }
    if (hardMisses.length) {
      console.log(`  UNACCOUNTED: ${hardMisses.map(s => s.value + ' (' + s.label + ')').join(', ')}`);
    }
    const othersFound = expected.otherCodes.filter(c => texts.has(c));
    console.log(`  other expected codes: ${othersFound.length}/${expected.otherCodes.length}`);
  }
  console.log(allOk ? '\nALL SERIALS ACCOUNTED FOR' : '\nSome serials unaccounted (need retake flag — see above)');
  process.exit(allOk ? 0 : 1);
})().catch(err => { console.error(err); process.exit(2); });
