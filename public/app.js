'use strict';

// Client for the barcode-scanner API. All decoded/OCR/filename values are
// inserted with textContent (never raw markup), because barcode payloads are
// arbitrary user-controlled strings.

const API_TIMEOUT_MS = 180000;

const drop = document.getElementById('drop');
const fileInput = document.getElementById('fileInput');
const photosEl = document.getElementById('photos');
const summaryEl = document.getElementById('summary');
const serialsOut = document.getElementById('serialsOut');
const copyAllBtn = document.getElementById('copyAll');
const csvBtn = document.getElementById('csvBtn');
const clearAllBtn = document.getElementById('clearAll');
const groupsEl = document.getElementById('groups');

// Per-photo state:
//   cardValue: Map(cardId -> {value, source})  serial shown on each card
//   confirmed: Map(value  -> {value, source, model, label})  summary source
//   ocrCards:  [{value}]  synthetic whole-photo OCR cards (no analysis card)
const photos = [];

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
drop.addEventListener('dragover', e => e.preventDefault());
drop.addEventListener('drop', e => { e.preventDefault(); handleFiles(e.dataTransfer.files); });
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

copyAllBtn.addEventListener('click', () => {
  serialsOut.select();
  navigator.clipboard.writeText(serialsOut.value).catch(() => document.execCommand('copy'));
});

clearAllBtn.addEventListener('click', () => {
  for (const p of photos) URL.revokeObjectURL(p.imgUrl);
  photos.length = 0;
  photosEl.replaceChildren();
  groupsEl.replaceChildren();
  serialsOut.value = '';
  summaryEl.style.display = 'none';
});

csvBtn.addEventListener('click', () => {
  const rows = [['model', 'serial', 'photo', 'card', 'source']];
  for (const g of serialGroups()) {
    for (const e of g.entries) rows.push([g.model, e.value, e.photo, e.card, e.source]);
  }
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'serials.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

/** Quote a CSV cell and neutralize spreadsheet formula injection. */
function csvCell(value) {
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function cardLabel(analysis, cardId) {
  const idx = analysis.cards.findIndex(c => c.id === cardId);
  return idx >= 0 ? `Drive ${idx + 1}` : String(cardId);
}

function cardModel(analysis, cardId) {
  const card = analysis.cards.find(c => c.id === cardId);
  return card && card.model ? card.model : null;
}

function confirmSerial(state, value, source, model, label) {
  if (!value || state.confirmed.has(value)) return;
  state.confirmed.set(value, { value, source, model: model || null, label });
}

// All confirmed serials across the batch, clustered by captured model/MPN.
// Model/label are frozen at confirmation time so re-scans cannot misattribute
// a serial to a different card.
function serialGroups() {
  const groups = new Map();
  for (const p of photos) {
    if (!p.analysis) continue;
    for (const e of p.confirmed.values()) {
      const model = e.model || 'Model not detected';
      if (!groups.has(model)) groups.set(model, []);
      groups.get(model).push({ value: e.value, source: e.source, photo: p.file.name, card: e.label });
    }
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] === 'Model not detected') - (b[0] === 'Model not detected') || a[0].localeCompare(b[0]))
    .map(([model, entries]) => ({ model, entries }));
}

// Sequential queue: scans are CPU-heavy on the server, so batch uploads are
// processed one photo at a time to keep latency predictable.
let queue = Promise.resolve();
function handleFiles(list) {
  for (const file of list) {
    const state = {
      file,
      imgUrl: URL.createObjectURL(file),
      cardValue: new Map(),
      confirmed: new Map(),
      ocrCards: [],
    };
    photos.push(state);
    const section = renderPhotoShell(state);
    photosEl.appendChild(section);
    queue = queue.then(() => scanOne(state, section, false));
  }
}

/** POST a multipart image with a client timeout and readable error messages. */
async function postImage(url, state, extra = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const fd = new FormData();
    fd.append('image', state.file);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    let res;
    try {
      res = await fetch(url, { method: 'POST', body: fd, signal: ctrl.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Timed out — try a smaller photo or region.');
      throw new Error('Network error — is the server reachable?');
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      throw new Error(data.error || ({
        401: 'Authentication required — reload and sign in.',
        413: 'Image too large.',
        429: 'Too many requests — wait and retry.',
        503: 'Server busy — try again shortly.',
        504: 'Timed out — try a smaller photo or region.',
      }[res.status] || `Request failed (${res.status})`));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function scanOne(state, section, deep) {
  try {
    const data = await postImage('/scan', state, deep ? { deep: '1' } : {});
    state.analysis = data;
    renderAnalysis(state, section);
  } catch (err) {
    section.querySelector('.meta').textContent = 'Error: ' + err.message;
  }
}

function renderPhotoShell(state) {
  const section = document.createElement('section');
  section.className = 'photo';

  const h3 = document.createElement('h3');
  h3.textContent = state.file.name;
  section.appendChild(h3);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const spin = document.createElement('span');
  spin.className = 'spin';
  meta.append(spin, document.createTextNode(' queued / decoding… ~5–25s per photo (50MP longer); batch uploads run one at a time'));
  section.appendChild(meta);

  const wrap = document.createElement('div');
  wrap.className = 'overviewWrap';
  wrap.style.display = 'none';
  const img = document.createElement('img');
  img.alt = state.file.name;
  img.src = state.imgUrl;
  const canvas = document.createElement('canvas');
  const selRect = document.createElement('div');
  selRect.className = 'selRect';
  wrap.append(img, canvas, selRect);
  section.appendChild(wrap);

  const cards = document.createElement('div');
  cards.className = 'cards';
  section.appendChild(cards);

  enableRegionSelect(state, section);
  return section;
}

function renderAnalysis(state, section) {
  const a = state.analysis;
  section.querySelector('.meta').textContent =
    `${a.width}×${a.height} — ${a.results.length} codes, ${a.cards.length} drive(s), ${(a.elapsedMs / 1000).toFixed(1)}s. ` +
    `Drag a rectangle on the photo to re-scan a region.`;

  const wrap = section.querySelector('.overviewWrap');
  wrap.style.display = 'inline-block';
  drawBoxes(state, section);

  // Barcode serials are re-derived from the fresh analysis; OCR-confirmed ones
  // persist. Clear only barcode entries so nothing is duplicated or stale.
  for (const [k, v] of state.cardValue) if (v.source === 'barcode') state.cardValue.delete(k);

  const cardsEl = section.querySelector('.cards');
  cardsEl.replaceChildren();
  a.cards.forEach((card, i) => cardsEl.appendChild(renderCard(state, card, i)));

  const recovery = renderRecovery(state, section, a);
  for (const oc of state.ocrCards) cardsEl.appendChild(renderOcrCard(state, oc.value));
  cardsEl.appendChild(recovery);
  refreshSummary();
}

function renderRecovery(state, section, a) {
  const row = document.createElement('div');
  row.className = 'hint';
  row.appendChild(document.createTextNode('Missing a drive or an expected field? '));

  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = 'Run OCR assist on whole photo';
  btn.onclick = () => runOcr(state, { id: 'whole', bounds: { left: 0, top: 0, width: a.width, height: a.height } }, row, btn);
  row.appendChild(btn);

  if (!a.deepRan) {
    row.appendChild(document.createTextNode(' '));
    const deepBtn = document.createElement('button');
    deepBtn.textContent = 'Deep re-scan (slow)';
    deepBtn.onclick = () => {
      const meta = section.querySelector('.meta');
      meta.textContent = 'deep scanning (tiles at full resolution)…';
      deepBtn.disabled = true;
      scanOne(state, section, true);
    };
    row.appendChild(deepBtn);
  }
  row.appendChild(document.createTextNode(' For an unreadable label, retake closer: one drive filling the frame, label flat, no glare.'));
  return row;
}

function drawBoxes(state, section) {
  const img = section.querySelector('img');
  const canvas = section.querySelector('canvas');
  const paint = () => {
    const sx = img.clientWidth / state.analysis.width;
    const sy = img.clientHeight / state.analysis.height;
    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const r of state.analysis.results) {
      if (!r.bounds) continue;
      ctx.strokeStyle = r.kind === 'serial' ? '#1a7f37' : '#0969da';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.bounds.left * sx, r.bounds.top * sy, r.bounds.width * sx, r.bounds.height * sy);
    }
  };
  if (img.complete) paint(); else img.onload = paint;
}

/** Only accept same-page image data URIs as thumbnail sources. */
function safeThumb(thumb) {
  return (typeof thumb === 'string' && thumb.startsWith('data:image/jpeg;base64,')) ? thumb : null;
}

function renderCard(state, card, idx) {
  const a = state.analysis;
  const items = card.itemIds.map(id => a.results[id]).filter(Boolean);
  const serialItem = card.serialId != null ? a.results[card.serialId] : null;
  const confirmed = state.cardValue.get(card.id);
  const div = document.createElement('div');
  div.className = 'card ' + (serialItem || confirmed ? 'ok' : card.status);
  const makes = [...new Set(items.map(r => r.make).filter(Boolean))];

  const head = document.createElement('h4');
  const title = card.model || (makes.length ? makes.join('/') : null);
  head.textContent = `Drive ${idx + 1}${title ? ' — ' + title : ''}`;
  div.appendChild(head);

  if (serialItem) {
    state.cardValue.set(card.id, { value: serialItem.text, source: 'barcode' });
    confirmSerial(state, serialItem.text, 'barcode', card.model, `Drive ${idx + 1}`);
    div.appendChild(serialRow(serialItem.text, 'barcode'));
  } else if (confirmed) {
    div.appendChild(serialRow(confirmed.value, 'ocr'));
  } else if (card.preloadedOcr) {
    renderProposals(state, card, div, card.preloadedOcr);
  } else {
    // Not a failure: labels differ — some carry the SN only as printed text.
    const note = document.createElement('div');
    note.className = 'meta';
    note.textContent = 'No serial-typed code among these. All detected fields are listed below as decoded.';
    div.appendChild(note);
    const ocrBtn = document.createElement('button');
    ocrBtn.textContent = 'Run OCR assist';
    ocrBtn.onclick = () => runOcr(state, card, div, ocrBtn);
    div.appendChild(ocrBtn);
  }

  const codes = document.createElement('div');
  codes.className = 'codes';
  for (const r of items) {
    const row = document.createElement('div');
    row.className = 'code';

    const thumb = safeThumb(r.thumb);
    if (thumb) {
      const img = document.createElement('img');
      img.src = thumb;
      img.title = 'source region';
      row.appendChild(img);
    }

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = r.text;
    row.appendChild(txt);

    const badge = document.createElement('span');
    badge.className = 'badge kind';
    if (r.via) badge.title = r.via;
    badge.textContent = `${r.format}·${r.kind}${r.via ? '⧉' : ''}`;
    row.appendChild(badge);

    const btn = document.createElement('button');
    btn.textContent = 'copy';
    btn.onclick = () => navigator.clipboard.writeText(r.text);
    row.appendChild(btn);

    codes.appendChild(row);
  }
  div.appendChild(codes);
  return div;
}

function serialRow(value, source) {
  const row = document.createElement('div');
  const span = document.createElement('span');
  span.className = 'serial';
  span.textContent = value;
  const badge = document.createElement('span');
  badge.className = 'badge ' + source;
  badge.textContent = source === 'ocr' ? 'OCR — confirmed' : 'barcode';
  const btn = document.createElement('button');
  btn.textContent = 'copy';
  btn.onclick = () => navigator.clipboard.writeText(value);
  row.append(span, badge, btn);
  return row;
}

function renderOcrCard(state, value) {
  const div = document.createElement('div');
  div.className = 'card ok';
  const head = document.createElement('h4');
  head.textContent = 'OCR-assisted serial';
  div.append(head, serialRow(value, 'ocr'));
  return div;
}

// Render OCR proposals into container; accepting one sets the card's serial
// (or creates a new card for whole-photo / region OCR results).
function renderProposals(state, card, container, candidates) {
  if (!candidates.length) {
    const none = document.createElement('div');
    none.className = 'meta';
    none.textContent = 'OCR found no serial-shaped text here.';
    container.appendChild(none);
    return;
  }
  for (const c of candidates) {
    const row = document.createElement('div');
    row.className = 'proposal';
    const value = document.createElement('span');
    value.textContent = c.value;
    const badge = document.createElement('span');
    badge.className = 'badge ocr';
    badge.textContent = `OCR? ${c.votes ? `${c.votes}/${c.of} reads, ` : ''}conf ${c.confidence}`;
    const use = document.createElement('button');
    use.textContent = 'Use this';
    use.onclick = () => acceptProposal(state, card, container, c.value);
    row.append(value, badge, use);
    container.appendChild(row);
  }
  const note = document.createElement('div');
  note.className = 'meta';
  note.textContent = 'OCR misreads characters on these labels (8/R, 0/O) — verify against the photo before using.';
  container.appendChild(note);
}

function removeDynamic(container) {
  container.querySelectorAll('.proposal, .meta').forEach(p => p.remove());
}

function acceptProposal(state, card, container, value) {
  const section = container.closest('.photo');
  if (card.id === 'whole') {
    state.ocrCards.push({ value });
    confirmSerial(state, value, 'ocr', null, 'OCR-assisted');
    const cardsEl = section.querySelector('.cards');
    cardsEl.insertBefore(renderOcrCard(state, value), cardsEl.lastElementChild);
  } else {
    state.cardValue.set(card.id, { value, source: 'ocr' });
    confirmSerial(state, value, 'ocr', cardModel(state.analysis, card.id), cardLabel(state.analysis, card.id));
    const cardEl = container.closest('.card');
    cardEl.className = 'card ok';
    const old = cardEl.querySelector('.serial');
    if (old) old.parentElement.remove();
    cardEl.insertBefore(serialRow(value, 'ocr'), cardEl.children[1] || null);
  }
  removeDynamic(container);
  refreshSummary();
}

async function runOcr(state, card, container, btn) {
  btn.disabled = true;
  btn.textContent = '';
  const spinner = document.createElement('span');
  spinner.className = 'spin';
  btn.append(spinner, document.createTextNode(' OCR…'));
  try {
    const data = await postImage('/ocr', state, {
      crop_left: Math.round(card.bounds.left),
      crop_top: Math.round(card.bounds.top),
      crop_width: Math.round(card.bounds.width),
      crop_height: Math.round(card.bounds.height),
    });
    btn.remove();
    renderProposals(state, card, container, data.candidates || []);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = `Run OCR assist (${err.message})`;
  }
}

function enableRegionSelect(state, section) {
  const canvas = section.querySelector('canvas');
  const rect = section.querySelector('.selRect');
  let start = null;

  const point = e => {
    const b = canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top, b };
  };

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    start = point(e);
    rect.style.display = 'block';
  });

  canvas.addEventListener('pointermove', e => {
    if (!start) return;
    const p = point(e);
    const x = Math.min(start.x, p.x);
    const y = Math.min(start.y, p.y);
    Object.assign(rect.style, {
      left: x + 'px', top: y + 'px',
      width: Math.abs(p.x - start.x) + 'px',
      height: Math.abs(p.y - start.y) + 'px',
    });
  });

  canvas.addEventListener('pointerup', async e => {
    if (!start) return;
    const p = point(e);
    const w = Math.abs(p.x - start.x);
    const h = Math.abs(p.y - start.y);
    const x = Math.min(start.x, p.x);
    const y = Math.min(start.y, p.y);
    start = null;
    rect.style.display = 'none';
    if (w < 12 || h < 12 || !state.analysis) return;
    const sx = state.analysis.width / canvas.clientWidth;
    const sy = state.analysis.height / canvas.clientHeight;
    const meta = section.querySelector('.meta');
    meta.textContent = 're-scanning region (barcodes + OCR)…';
    try {
      const data = await postImage('/scan-region', state, {
        crop_left: Math.round(x * sx),
        crop_top: Math.round(y * sy),
        crop_width: Math.round(w * sx),
        crop_height: Math.round(h * sy),
      });
      mergeRegionResults(state, data);
      renderAnalysis(state, section);
    } catch (err) {
      meta.textContent = 'Region scan error: ' + err.message;
    }
  });
}

// Append region-scan hits as one extra card; OCR candidates become proposals.
function mergeRegionResults(state, data) {
  const a = state.analysis;
  const base = a.results.length;
  for (const r of data.results) {
    if (a.results.some(x => x.text === r.text && x.format === r.format)) continue;
    r.id = a.results.length;
    a.results.push(r);
  }
  const newIds = a.results.slice(base).map(r => r.id);
  const card = {
    id: a.cards.length,
    itemIds: newIds,
    serialId: null,
    bounds: data.region,
    status: 'no-serial',
  };
  const serial = data.results.find(r => r.kind === 'serial');
  if (serial) {
    card.serialId = a.results.find(r => r.text === serial.text && r.format === serial.format)?.id ?? null;
    card.status = card.serialId != null ? 'ok' : 'no-serial';
  }
  if (newIds.length || data.ocrCandidates.length) {
    a.cards.push(card);
    if (data.ocrCandidates.length) {
      a.cards.push({
        id: a.cards.length,
        itemIds: [],
        serialId: null,
        bounds: data.region,
        status: 'no-serial',
        preloadedOcr: data.ocrCandidates,
      });
    }
  }
}

function refreshSummary() {
  const groups = serialGroups();
  const lines = [];
  groupsEl.replaceChildren();
  for (const g of groups) {
    const head = document.createElement('div');
    head.className = 'groupHead';
    head.textContent = `${g.model} (${g.entries.length})`;
    groupsEl.appendChild(head);
    for (const e of g.entries) {
      lines.push(e.value);
      const row = document.createElement('div');
      row.className = 'groupRow';
      const span = document.createElement('span');
      span.className = 'txt';
      span.textContent = e.value;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${e.photo} · ${e.card}${e.source === 'ocr' ? ' · OCR-confirmed' : ''}`;
      const btn = document.createElement('button');
      btn.textContent = 'copy';
      btn.onclick = () => navigator.clipboard.writeText(e.value);
      row.append(span, meta, btn);
      groupsEl.appendChild(row);
    }
  }
  summaryEl.style.display = lines.length ? 'block' : 'none';
  serialsOut.value = lines.join('\n');
}
