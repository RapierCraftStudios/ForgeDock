// Minimal token-based auth for the demo Notes API.
//
// The "token" is just a static demo secret — there are no real users or
// sessions. Routes that should be protected call `requireToken(req)`.
//
// >>> DEMO NOTE: In routes/notes.js, one mutating route deliberately does NOT
// >>> call requireToken(). That missing-auth check is an INTENTIONAL flaw so
// >>> ForgeDock's review agents have an authorization gap to flag.

const DEMO_TOKEN = 'demo-token';

// Returns true when the request carries the demo bearer token.
function isAuthenticated(req) {
  const header = req.headers['authorization'] || '';
  const [scheme, value] = header.split(' ');
  return scheme === 'Bearer' && value === DEMO_TOKEN;
}

// Throws a 401-style error when the request is not authenticated.
function requireToken(req) {
  if (!isAuthenticated(req)) {
    const err = new Error('Unauthorized: missing or invalid bearer token');
    err.statusCode = 401;
    throw err;
  }
}

module.exports = { isAuthenticated, requireToken, DEMO_TOKEN };
