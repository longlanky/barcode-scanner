'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classify, groupIntoCards, parsePayload, extractModel } = require('../lib/classify');
const { canonicalFormat } = require('../lib/pipeline');

const FORMATS = ['Code39', 'Code128', 'DataMatrix'];

function kindsFor(value) {
  return FORMATS.map(f => classify(value, f).kind);
}

test('classify: real serials are serials under their symbologies', () => {
  const serials = [
    ['S1DHNSAF610222X', 'Code128'],   // Samsung
    ['WCC6MAZKR83L', 'Code128'],      // WD
    ['PNY43172231060106843', 'Code128'],
    ['ME1605021001CF039', 'Code39'],
    ['1714169B70C6', 'Code128'],      // Crucial
    ['50026B7779026C1C', 'Code128'],  // Kingston
    ['ZRT2M3DG', 'Code39'],
    ['W4Z4E0DA', 'Code39'],
    ['S1DE0TYN', 'Code39'],
    ['BN1VXM6E', 'Code39'],
  ];
  for (const [value, fmt] of serials) {
    assert.equal(classify(value, fmt).kind, 'serial', `${value} (${fmt})`);
  }
});

test('classify: model/batch codes are NOT promoted to serial (regression)', () => {
  const models = ['WD10EZEX', 'ST2000DM', '12345678', 'WD5000AZLX', 'CT1050MX300SSD1'];
  for (const value of models) {
    assert.ok(!kindsFor(value).includes('serial'), `${value} must not classify as serial`);
  }
});

test('classify: non-serial kinds stay correct', () => {
  assert.equal(classify('5002538E40A1B2C3', 'Code128').kind, 'wwn');
  assert.equal(classify('A'.repeat(32), 'DataMatrix').kind, 'psid');
  assert.equal(classify('WD1005FBYZ-01YCBB3', 'Code128').kind, 'part');
  assert.equal(classify('ST12000VN0008', 'Code128').kind, 'part');
  assert.equal(classify('https://seagate.com/verify', 'QRCode').kind, 'url');
  assert.equal(classify('random', 'QRCode').kind, 'other');
});

test('parsePayload: splits SN/MPN/PSID across whitespace styles', () => {
  const payload = 'SN:1714169B70C6 MPN:CT1050MX300SSD1 PSID:' + 'A'.repeat(32);
  for (const sep of [' ', '\t', '\n', '   ']) {
    const text = payload.split(' ').join(sep);
    const fields = parsePayload(text);
    assert.ok(fields, `should parse with ${JSON.stringify(sep)}`);
    const byField = Object.fromEntries(fields.map(f => [f.field, f]));
    assert.equal(byField.SN.value, '1714169B70C6');
    assert.equal(byField.SN.kind, 'serial');
    assert.equal(byField.MPN.kind, 'part');
    assert.equal(byField.PSID.kind, 'psid');
  }
});

test('parsePayload: rejects non-payload text', () => {
  assert.equal(parsePayload('HELLO WORLD'), null);
  assert.equal(parsePayload('SN:1714169B70C6 trailing junk'), null);
});

test('canonicalFormat: normalizes engine/Code39 variant names', () => {
  assert.equal(canonicalFormat('CODE128'), 'Code128');
  assert.equal(canonicalFormat('Code128'), 'Code128');
  assert.equal(canonicalFormat('Code39'), 'Code39');
  assert.equal(canonicalFormat('Code39Std'), 'Code39');
  assert.equal(canonicalFormat('Code39Ext'), 'Code39');
  assert.equal(canonicalFormat('QRCode'), 'QRCode');
  assert.equal(canonicalFormat('DataMatrix'), 'DataMatrix');
});

test('extractModel: pulls known model/MPN prefixes', () => {
  assert.equal(extractModel('ST2000DM006'), 'ST2000DM006');
  assert.equal(extractModel('WD10EZEX-75WN4A0'), 'WD10EZEX');
  assert.equal(extractModel('CT1050MX300SSD1'), 'CT1050MX300SSD1');
  assert.equal(extractModel('MZ-77E1T0'), 'MZ-77E1T0');
  assert.equal(extractModel('not-a-model'), null);
});

const box = (left, top, w = 50, h = 50) => ({ left, top, width: w, height: h });

test('groupIntoCards: empty input yields no cards', () => {
  assert.deepEqual(groupIntoCards([], 1000, 1000), []);
});

test('groupIntoCards: nearby hits attach to the serial anchor', () => {
  const results = [
    { kind: 'serial', text: 'ZRT2M3DG', bounds: box(0, 0) },
    { kind: 'part', text: 'WD10EZEX-75WN4A0', bounds: box(60, 0) },
  ];
  const cards = groupIntoCards(results, 1000, 1000);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'ok');
  assert.equal(cards[0].items.length, 2);
});

test('groupIntoCards: distant serials form separate cards', () => {
  const results = [
    { kind: 'serial', text: 'ZRT2M3DG', bounds: box(0, 0) },
    { kind: 'serial', text: 'W4Z4E0DA', bounds: box(900, 900) },
  ];
  const cards = groupIntoCards(results, 1000, 1000);
  assert.equal(cards.length, 2);
  assert.ok(cards.every(c => c.status === 'ok'));
});

test('groupIntoCards: no-serial hits cluster by distance, degenerate bounds excluded', () => {
  const results = [
    { kind: 'part', text: 'A', bounds: box(100, 100) },
    { kind: 'part', text: 'B', bounds: box(120, 100) },
    { kind: 'part', text: 'C', bounds: box(900, 900) },
    { kind: 'part', text: 'D', bounds: null },
  ];
  const cards = groupIntoCards(results, 1000, 1000);
  assert.equal(cards.length, 2);
  assert.ok(cards.every(c => c.status === 'no-serial'));
  const sizes = cards.map(c => c.items.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});

test('client assets are XSS-safe / CSP-ready', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!app.includes('innerHTML'), 'app.js must not use innerHTML');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/<script src="\/app\.js" defer><\/script>/.test(html), 'index.html must load external app.js');
  assert.ok(!/<script>[\s\S]*<\/script>/.test(html), 'index.html must not contain inline script');
});
