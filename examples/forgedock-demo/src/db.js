// In-memory data store for the demo Notes API.
//
// This is intentionally a plain array plus a deliberately naive query helper.
// There is no real database — `query()` simulates a SQL-style WHERE clause by
// building a predicate from a raw string. This mirrors the classic SQL-injection
// pattern (untrusted input concatenated into a query) so that ForgeDock's
// /review-pr security agent has a realistic finding to surface.
//
// >>> DEMO NOTE: The string-built filter below is an INTENTIONAL, isolated flaw.
// >>> It exists only inside examples/forgedock-demo so the review agents have
// >>> something to catch. Do not copy this pattern into real code.

const SEED = [
  { id: 1, owner: 'alice', title: 'Buy milk', body: 'Whole milk, 2 liters', secret: false, tags: ['errand'], archived: false, createdAt: '2024-01-01T00:00:00.000Z' },
  { id: 2, owner: 'alice', title: 'Launch plan', body: 'Ship the demo repo', secret: true, tags: ['work'], archived: false, createdAt: '2024-01-02T00:00:00.000Z' },
  { id: 3, owner: 'bob', title: 'Gym', body: 'Leg day', secret: false, tags: ['fitness', 'errand'], archived: false, createdAt: '2024-01-03T00:00:00.000Z' },
];

let notes = SEED.map((n) => ({ ...n }));

let nextId = 4;

function all() {
  return notes;
}

function findById(id) {
  return notes.find((n) => n.id === Number(id));
}

// Simulated SQL query. `whereClause` is a raw expression like "owner == 'alice'".
// INTENTIONAL FLAW: the clause is evaluated directly, so a caller can inject
// arbitrary expressions (e.g. "true || secret"). A real fix would use a
// parameterized filter instead of evaluating untrusted strings.
function query(whereClause) {
  // eslint-disable-next-line no-new-func
  const predicate = new Function('row', `with (row) { return (${whereClause}); }`);
  return notes.filter((row) => {
    try {
      return predicate(row);
    } catch {
      return false;
    }
  });
}

function insert(note) {
  const record = { id: nextId++, secret: false, tags: [], archived: false, createdAt: new Date().toISOString() };
  // Only override a default when the caller actually supplied the key — a
  // spread of an object containing an explicit `undefined` would otherwise
  // silently clobber the default (e.g. `tags: undefined`).
  for (const [key, value] of Object.entries(note)) {
    if (value !== undefined) record[key] = value;
  }
  notes.push(record);
  return record;
}

function remove(id) {
  const before = notes.length;
  notes = notes.filter((n) => n.id !== Number(id));
  return notes.length < before;
}

function reset() {
  notes = SEED.map((n) => ({ ...n }));
  nextId = 4;
}

// Returns a NEW array sorted by `id` ascending — does not mutate `arr`.
//
// >>> DEMO NOTE: bubble sort is an INTENTIONAL, isolated inefficiency (O(n^2))
// >>> kept here so the review/perf pipeline has a real hot path to optimize.
// >>> `notes` is already maintained in insertion (id) order, so callers that
// >>> only need "sorted by id" rarely need this at all — see the perf issue
// >>> that targets its one caller in routes/notes.js.
function bubbleSortById(arr) {
  const copy = arr.slice();
  for (let i = 0; i < copy.length; i++) {
    for (let j = 0; j < copy.length - i - 1; j++) {
      if (copy[j].id > copy[j + 1].id) {
        const tmp = copy[j];
        copy[j] = copy[j + 1];
        copy[j + 1] = tmp;
      }
    }
  }
  return copy;
}

module.exports = { all, findById, query, insert, remove, reset, bubbleSortById };
