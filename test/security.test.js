'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');

const REPO = path.join(__dirname, '..');
const USER = 'auditor';
const PASS = 's3cret-pass';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

let nextPort = 3500 + Math.floor(Math.random() * 500);

function withServer(env, fn) {
  return new Promise((resolve, reject) => {
    const port = nextPort++;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: REPO,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', APP_USER: USER, APP_PASS: PASS, ...env },
    });
    let out = '';
    let ready = false;
    const fail = err => { try { child.kill('SIGKILL'); } catch {} reject(err); };
    const timer = setTimeout(() => fail(new Error('server did not start: ' + out)), 20000);
    const onData = d => {
      out += d.toString();
      if (!ready && /Server running/.test(out)) {
        ready = true;
        clearTimeout(timer);
        Promise.resolve(fn(`http://127.0.0.1:${port}`))
          .then(resolve, reject)
          .finally(() => child.kill('SIGTERM'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => { if (!ready) fail(new Error(`server exited (${code}): ${out}`)); });
  });
}

function authed(url, opts = {}) {
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}), authorization: AUTH } });
}

test('unauthenticated requests are rejected with 401', async () => {
  await withServer({}, async base => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /Basic/);
    const api = await fetch(base + '/scan', { method: 'POST' });
    assert.equal(api.status, 401);
  });
});

test('authenticated page load succeeds with security headers', async () => {
  await withServer({}, async base => {
    const res = await authed(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Drive Serial Scanner/);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp, 'CSP header present');
    assert.ok(!/unsafe-inline/.test(csp.replace(/style-src[^;]*/, '')),
      'script-src must not allow unsafe-inline');
    assert.match(csp, /img-src[^;]*blob:/, 'img-src must allow blob: photo previews');
  });
});

test('wrong credentials are rejected', async () => {
  await withServer({}, async base => {
    const bad = 'Basic ' + Buffer.from('auditor:wrong').toString('base64');
    const res = await fetch(base + '/', { headers: { authorization: bad } });
    assert.equal(res.status, 401);
  });
});

test('missing image returns JSON, not an HTML error page', async () => {
  await withServer({}, async base => {
    const res = await authed(base + '/scan', { method: 'POST' });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await res.json(), { error: 'No image uploaded' });
  });
});

test('rate limit returns 429 after the configured quota', async () => {
  await withServer({ RATE_LIMIT: '2' }, async base => {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const res = await authed(base + '/scan', { method: 'POST' });
      statuses.push(res.status);
    }
    assert.equal(statuses[0], 400, 'first request reaches the route');
    assert.equal(statuses[3], 429, 'fourth request is limited');
  });
});

test('over-large decoded image is rejected with 413 before decode', async () => {
  await withServer({ MAX_PIXELS: '100' }, async base => {
    const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: 'white' } }).png().toBuffer();
    const fd = new FormData();
    fd.append('image', new Blob([png], { type: 'image/png' }), 'big.png');
    const res = await authed(base + '/scan', { method: 'POST', body: fd });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /too large/i);
  });
});
