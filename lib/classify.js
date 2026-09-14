/**
 * Result classification (serial vs wwn vs psid vs ...) and spatial grouping
 * of hits into per-drive cards. Rules are ordered: first match wins.
 * Tuned from hand-verified HDD/SSD labels (see tools/expected.json).
 */

const RULES = [
  // Samsung SSD serials (15 chars): S1DHNSAF610222X, S36SNWAH905482A, S6PKNS0YA06718D
  { kind: 'serial', make: 'Samsung', re: /^S[A-Z0-9]{3}N[A-Z0-9]{9,12}$/ },
  // WD serials: WCC6MAZKR83L
  { kind: 'serial', make: 'WD', re: /^W[A-Z]{2}[A-Z0-9]{9}$/ },
  // PNY serials: PNY43172231060106843
  { kind: 'serial', make: 'PNY', re: /^PNY\d{17}$/ },
  // Mushkin serials: ME1605021001CF039 (only barcode on the label)
  { kind: 'serial', make: 'Mushkin', re: /^ME[0-9A-Z]{15}$/ },
  // Crucial serials: 1714169B70C6, 1735E101E68F (year-week prefix + alnum)
  { kind: 'serial', make: 'Crucial', re: /^1[0-9]{3}[A-Z0-9]{7,9}$/ },
  // Kingston SSDs: the 50026B... value doubles as S/N and WWN
  { kind: 'serial', make: 'Kingston', re: /^50026B[0-9A-F]{10}$/ },
  // Seagate/HGST 8-char Code 39 serials: ZRT2M3DG, W4Z4E0DA, S1DE0TYN, BN1VXM6E
  { kind: 'serial', re: /^[A-Z0-9]{8}$/, formats: ['Code39'] },
  // URLs (Seagate verify QR codes etc.)
  { kind: 'url', re: /^https?:\/\//i },
  // WWN: 16 hex chars (Samsung 50025388..., WD 50014EE..., Seagate 5000C50...)
  { kind: 'wwn', re: /^[0-9A-F]{16}$/i },
  // PSID: 32-char alphanumeric (Samsung/Seagate Data Matrix contents)
  { kind: 'psid', re: /^[A-Z0-9]{32}$/ },
  // Model/part numbers contain dashes: WD1005FBYZ-01YCBB3, 2YS101-500
  { kind: 'part', re: /-/ },
  // Seagate model without dash: ST12000VN0008; Crucial MPN: CT1050MX300SSD1
  { kind: 'part', re: /^ST\d+[A-Z]+\d+$/ },
  { kind: 'part', re: /^CT\d+[A-Z0-9]+$/ },
];

function classify(text, format) {
  for (const rule of RULES) {
    if (rule.formats && !rule.formats.includes(format)) continue;
    if (rule.re.test(text)) return { kind: rule.kind, make: rule.make || null };
  }
  return { kind: 'other', make: null };
}

/**
 * Best-effort model/MPN extraction from a decoded value, for batch clustering.
 * Ordered by reliability: explicit model strings before dash-prefixes.
 */
const MODEL_RULES = [
  /^(ST\d{4,}[A-Z0-9]*)$/,          // Seagate MPN: ST2000DM006
  /^(WD\d+[A-Z0-9]+?)(?:-|$)/,      // WD model prefix: WD10EZEX-75WN4A0
  /^(CT\d+[A-Z0-9]+)$/,             // Crucial MPN: CT1050MX300SSD1
  /^(MZ-?[A-Z0-9]{3,})/,            // Samsung model: MZ-77E1T0 / MZ7LN500HAJQ
  /^(HTS\d+[A-Z0-9]+)/,             // HGST model: HTS721010A9E630
  /^PNY\s+([A-Z]+\d+)/,             // PNY part text: "PNY CS900 240GB SSD"
  /^([A-Z]{2,}\d*S\d+\d*)\//,       // Kingston model/family: SA400S37/120G
  /^(MKN[A-Z0-9]+?)(?:GB)?$/,       // Mushkin model text: MKNSSDE3480GB
];

function extractModel(text) {
  for (const re of MODEL_RULES) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Pick the best model key for a card's items (first match wins). */
function modelOf(items) {
  for (const r of items) {
    const model = extractModel(r.text);
    if (model) return model;
  }
  return null;
}

/**
 * Some Data Matrix codes carry a structured multi-field payload instead of a
 * single value, e.g. Crucial: "SN:1714169B70C6 MPN:CT1050MX300SSD1 PSID:...".
 * Split those into individual fields so each shows up (and classifies) as its
 * own value. Returns null when the text is not a key:value payload.
 */
function parsePayload(text) {
  if (!/^[A-Z]{2,5}:/.test(text)) return null;
  const pairs = [...text.matchAll(/([A-Z]{2,5}):([^\s]+)/g)];
  if (!pairs.length) return null;
  // the whole string must consist of KEY:value pairs separated by spaces
  if (pairs.map(m => m[0]).join(' ') !== text) return null;
  return pairs.map(m => {
    const [, key, value] = m;
    if (key === 'SN') return { field: 'SN', value, kind: 'serial' };
    if (key === 'MPN' || key === 'PN' || key === 'MDL') return { field: key, value, kind: 'part' };
    if (key === 'PSID') return { field: key, value, kind: 'psid' };
    if (key === 'WWN') return { field: key, value, kind: 'wwn' };
    return { field: key, value, kind: null }; // classify by value
  });
}

/**
 * Group results into per-drive cards. Serial hits act as drive anchors (one
 * card each); every other hit attaches to its nearest anchor when close
 * enough. Hits with no anchor nearby cluster among themselves by distance.
 * This keeps sparse labels (Seagate: serial at top, QR at bottom) in one
 * card without merging adjacent drives.
 */
function groupIntoCards(results, W, H) {
  const maxDim = Math.max(W, H);
  const anchorRadius = 0.35 * maxDim;
  const clusterRadius = 0.15 * maxDim;

  const centers = results.map(r => {
    if (!r.bounds) return null;
    return { x: r.bounds.left + r.bounds.width / 2, y: r.bounds.top + r.bounds.height / 2 };
  });
  const dist = (i, j) => Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y);

  const anchors = results.map((r, i) => (r.kind === 'serial' && centers[i]) ? i : -1).filter(i => i >= 0);
  const assignment = new Array(results.length).fill(-1); // -> anchor index or -1

  if (anchors.length > 0) {
    results.forEach((r, i) => {
      if (!centers[i]) return;
      let best = -1;
      let bestD = anchorRadius;
      for (const a of anchors) {
        const d = dist(i, a);
        if (d < bestD) { bestD = d; best = a; }
      }
      assignment[i] = best;
    });
  }

  // Cluster the unassigned remainder by distance (union-find)
  const rest = results.map((_, i) => i).filter(i => centers[i] && assignment[i] === -1);
  const parent = new Map(rest.map(i => [i, i]));
  const find = i => { while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); } return i; };
  for (let a = 0; a < rest.length; a++) {
    for (let b = a + 1; b < rest.length; b++) {
      if (dist(rest[a], rest[b]) < clusterRadius) parent.set(find(rest[a]), find(rest[b]));
    }
  }

  const groups = new Map(); // groupKey -> item indices
  results.forEach((r, i) => {
    if (!centers[i]) return;
    const key = assignment[i] !== -1 ? 'a' + assignment[i] : 'c' + find(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });

  const cards = Array.from(groups.values()).map(idxList => {
    const items = idxList.map(i => results[i]);
    const serials = items.filter(r => r.kind === 'serial');
    const boxes = items.map(r => r.bounds).filter(Boolean);
    const left = Math.min(...boxes.map(b => b.left));
    const top = Math.min(...boxes.map(b => b.top));
    const right = Math.max(...boxes.map(b => b.left + b.width));
    const bottom = Math.max(...boxes.map(b => b.top + b.height));
    return {
      items,
      serial: serials.length > 0 ? serials[0] : null,
      bounds: boxes.length ? { left, top, width: right - left, height: bottom - top } : null,
      status: serials.length > 0 ? 'ok' : 'no-serial',
    };
  });
  // Stable spatial order: top-to-bottom, left-to-right
  cards.sort((a, b) => {
    if (!a.bounds || !b.bounds) return 0;
    return a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left;
  });
  return cards;
}

module.exports = { classify, groupIntoCards, extractModel, modelOf, parsePayload };
