// Route handlers for the demo Notes API.
//
// Each handler takes (req, res, params) and returns a plain object that the
// server serializes to JSON. Handlers throw errors with a `statusCode` to
// signal HTTP error responses.

const db = require('../db');
const { requireToken } = require('../auth');

// GET /notes
// Lists notes. Supports:
//   ?where=   — raw expression passed straight into db.query() (see db.js)
//   ?tag=     — exact match against a note's `tags` array
//   ?limit=, ?offset= — pagination
//
// >>> DEMO NOTE: forwarding the raw ?where= string into db.query() is the
// >>> injection surface (see db.js). Issue #2 asks to make this safe.
function listNotes(req, res, params) {
  const { where, tag, limit, offset } = params.query;

  let results = where ? db.query(where) : db.all();

  if (tag) {
    // >>> DEMO NOTE: `tags` is accepted but never validated as an array at
    // >>> write time (see createNote below). A note created with a
    // >>> malformed `tags` value makes this `.includes()` call throw instead
    // >>> of being skipped safely. INTENTIONAL, isolated flaw.
    results = results.filter((n) => n.tags.includes(tag));
  }

  if (limit !== undefined || offset !== undefined) {
    // >>> DEMO NOTE: `offset` is not clamped to a non-negative value, so a
    // >>> negative offset falls through to Array.prototype.slice's
    // >>> negative-index semantics (counts from the end) instead of being
    // >>> rejected or normalized to 0. INTENTIONAL, isolated flaw.
    const off = Number(offset) || 0;
    const lim = Number(limit);
    // Sorting by id here is redundant — `results` is already in id order —
    // but the demo intentionally uses the O(n^2) helper anyway (see db.js).
    const sorted = db.bubbleSortById(results);
    results = sorted.slice(off, Number.isFinite(lim) ? off + lim : undefined);
  }

  return { notes: results };
}

// GET /notes/count
// Returns { count } for notes matching optional ?owner= / ?secret= filters.
//
// >>> DEMO NOTE: builds its where-clause with naive string concatenation and
// >>> reuses the vulnerable db.query() eval path — the same injection class
// >>> issue #2 asks you to remove from listNotes, but reintroduced here in a
// >>> sibling endpoint issue #2's scope doesn't touch. INTENTIONAL, isolated
// >>> flaw kept for the benchmark corpus.
function countNotes(req, res, params) {
  const { owner, secret } = params.query;
  const clauses = [];
  if (owner) clauses.push('owner === "' + owner + '"');
  if (secret !== undefined) clauses.push('secret === ' + (secret === 'true'));
  const whereClause = clauses.length ? clauses.join(' && ') : 'true';
  return { count: db.query(whereClause).length };
}

// GET /notes/tags
// Returns the de-duplicated list of tags across all notes.
//
// >>> DEMO NOTE: de-dupes with a nested loop (checks every tag against every
// >>> unique tag seen so far) instead of a Set — O(n^2) on the total tag
// >>> count. INTENTIONAL, isolated inefficiency kept for the perf corpus.
function listTags(req, res, params) {
  const unique = [];
  for (const note of db.all()) {
    for (const t of note.tags || []) {
      let seen = false;
      for (const u of unique) {
        if (u === t) {
          seen = true;
          break;
        }
      }
      if (!seen) unique.push(t);
    }
  }
  return { tags: unique };
}

// GET /notes/:id
function getNote(req, res, params) {
  const note = db.findById(params.id);
  if (!note) {
    const err = new Error('Note not found');
    err.statusCode = 404;
    throw err;
  }
  return { note };
}

// POST /notes  (protected)
//
// >>> DEMO NOTE: accepts a `tags` field but never checks that it's an array
// >>> before storing it. A malformed value (e.g. a number) is stored as-is
// >>> and later crashes GET /notes?tag= (see listNotes). INTENTIONAL,
// >>> isolated flaw kept for the benchmark corpus.
function createNote(req, res, params) {
  requireToken(req);
  const { title, body, owner, tags } = params.body || {};
  if (!title) {
    const err = new Error('title is required');
    err.statusCode = 400;
    throw err;
  }
  const payload = { title, body: body || '', owner: owner || 'anonymous' };
  if (tags !== undefined) payload.tags = tags;
  const note = db.insert(payload);
  res.statusCode = 201;
  return { note };
}

// PATCH /notes/:id  (protected)
//
// >>> DEMO NOTE: applies `owner` and `secret` from the request body
// >>> unconditionally alongside `title`/`body`. Any caller holding the
// >>> shared demo token can reassign a note's ownership or flip its
// >>> `secret` flag to false, exposing it via the unauthenticated
// >>> GET /notes listing. This is a mass-assignment / over-permissive-write
// >>> flaw, distinct from issue #1's missing-auth-check pattern.
// >>> INTENTIONAL, isolated flaw kept for the benchmark corpus. Note that
// >>> `tags` is NOT among the fields this handler updates yet — that gap is
// >>> a separate, not-yet-built feature.
function updateNote(req, res, params) {
  requireToken(req);
  const note = db.findById(params.id);
  if (!note) {
    const err = new Error('Note not found');
    err.statusCode = 404;
    throw err;
  }
  const { title, body, owner, secret } = params.body || {};
  if (title !== undefined) note.title = title;
  if (body !== undefined) note.body = body;
  if (owner !== undefined) note.owner = owner;
  if (secret !== undefined) note.secret = secret;
  return { note };
}

// DELETE /notes/:id
//
// >>> DEMO NOTE: this mutating route is MISSING a requireToken(req) call, so
// >>> anyone can delete any note. That missing authorization check is the
// >>> INTENTIONAL flaw that Issue #1 (bug fix) asks you to close.
function deleteNote(req, res, params) {
  const ok = db.remove(params.id);
  if (!ok) {
    const err = new Error('Note not found');
    err.statusCode = 404;
    throw err;
  }
  return { deleted: Number(params.id) };
}

module.exports = { listNotes, countNotes, listTags, getNote, createNote, updateNote, deleteNote };
