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

let notes = [
  { id: 1, owner: 'alice', title: 'Buy milk', body: 'Whole milk, 2 liters', secret: false },
  { id: 2, owner: 'alice', title: 'Launch plan', body: 'Ship the demo repo', secret: true },
  { id: 3, owner: 'bob', title: 'Gym', body: 'Leg day', secret: false },
];

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
  const record = { id: nextId++, secret: false, ...note };
  notes.push(record);
  return record;
}

function remove(id) {
  const before = notes.length;
  notes = notes.filter((n) => n.id !== Number(id));
  return notes.length < before;
}

function reset() {
  notes = [
    { id: 1, owner: 'alice', title: 'Buy milk', body: 'Whole milk, 2 liters', secret: false },
    { id: 2, owner: 'alice', title: 'Launch plan', body: 'Ship the demo repo', secret: true },
    { id: 3, owner: 'bob', title: 'Gym', body: 'Leg day', secret: false },
  ];
  nextId = 4;
}

module.exports = { all, findById, query, insert, remove, reset };
