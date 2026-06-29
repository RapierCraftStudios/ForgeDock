// Entry point for the demo Notes API.
//
// Uses only Node's built-in `http` module — no Express, no npm install. Run it
// with `node src/server.js` (or `npm start`). The router below is intentionally
// small and hand-rolled so the whole codebase stays readable in a few minutes.

const http = require('http');
const { URL } = require('url');
const routes = require('./routes/notes');

const PORT = process.env.PORT || 3000;

// Route table: [method, pathRegex, handler]. A `:id` segment is captured.
const TABLE = [
  ['GET', /^\/notes$/, routes.listNotes],
  ['POST', /^\/notes$/, routes.createNote],
  ['GET', /^\/notes\/(?<id>\d+)$/, routes.getNote],
  ['DELETE', /^\/notes\/(?<id>\d+)$/, routes.deleteNote],
];

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // Health check.
  if (req.method === 'GET' && req.url === '/health') {
    res.statusCode = 200;
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const query = Object.fromEntries(url.searchParams.entries());

  const match = TABLE.find(
    ([method, pattern]) => method === req.method && pattern.test(url.pathname)
  );

  if (!match) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'Not found' }));
  }

  const [, pattern, handler] = match;
  const groups = url.pathname.match(pattern).groups || {};
  const body = req.method === 'POST' ? await readBody(req) : {};

  try {
    const result = handler(req, res, { ...groups, query, body });
    return res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    return res.end(JSON.stringify({ error: err.message }));
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Notes API listening on http://localhost:${PORT}`);
  });
}

module.exports = { server };
