// Tiny smoke test for the demo Notes API. No test framework, no deps.
// Starts the server on a random port, hits a few endpoints, and asserts.
// Run with: npm run smoke

const http = require('http');
const assert = require('assert');
const { server } = require('../src/server');

function request(port, method, path, { token, json } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let payload;
    if (json) {
      payload = JSON.stringify(json);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();

  const health = await request(port, 'GET', '/health');
  assert.strictEqual(health.status, 200, 'health should be 200');
  assert.strictEqual(health.body.status, 'ok', 'health status should be ok');

  const list = await request(port, 'GET', '/notes');
  assert.ok(Array.isArray(list.body.notes), 'GET /notes returns an array');
  assert.ok(list.body.notes.length >= 3, 'seed notes present');

  const created = await request(port, 'POST', '/notes', {
    token: 'demo-token',
    json: { title: 'smoke', owner: 'tester' },
  });
  assert.strictEqual(created.status, 201, 'POST with token returns 201');

  const unauth = await request(port, 'POST', '/notes', { json: { title: 'nope' } });
  assert.strictEqual(unauth.status, 401, 'POST without token returns 401');

  const count = await request(port, 'GET', '/notes/count');
  assert.strictEqual(typeof count.body.count, 'number', 'GET /notes/count returns a number');

  const tags = await request(port, 'GET', '/notes/tags');
  assert.ok(Array.isArray(tags.body.tags), 'GET /notes/tags returns an array');

  const page = await request(port, 'GET', '/notes?limit=1');
  assert.ok(page.body.notes.length <= 1, 'GET /notes?limit=1 returns at most one note');

  const noteId = created.body.note.id;
  const patched = await request(port, 'PATCH', `/notes/${noteId}`, {
    token: 'demo-token',
    json: { title: 'smoke (patched)' },
  });
  assert.strictEqual(patched.status, 200, 'PATCH with token returns 200');
  assert.strictEqual(patched.body.note.title, 'smoke (patched)', 'PATCH updates the title');

  // eslint-disable-next-line no-console
  console.log('SMOKE OK — health, list, create(auth), create(unauth), count, tags, pagination, patch all pass');
  server.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('SMOKE FAILED:', err.message);
  server.close();
  process.exit(1);
});
