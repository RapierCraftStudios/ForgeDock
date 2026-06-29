// Route handlers for the demo Notes API.
//
// Each handler takes (req, res, params) and returns a plain object that the
// server serializes to JSON. Handlers throw errors with a `statusCode` to
// signal HTTP error responses.

const db = require('../db');
const { requireToken } = require('../auth');

// GET /notes
// Lists notes. Supports an optional ?where= filter that is passed straight
// into db.query().
//
// >>> DEMO NOTE: forwarding the raw ?where= string into db.query() is the
// >>> injection surface (see db.js). Issue #2 asks to make this safe.
function listNotes(req, res, params) {
  const where = params.query.where;
  if (where) {
    return { notes: db.query(where) };
  }
  return { notes: db.all() };
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
function createNote(req, res, params) {
  requireToken(req);
  const { title, body, owner } = params.body || {};
  if (!title) {
    const err = new Error('title is required');
    err.statusCode = 400;
    throw err;
  }
  const note = db.insert({ title, body: body || '', owner: owner || 'anonymous' });
  res.statusCode = 201;
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

module.exports = { listNotes, getNote, createNote, deleteNote };
