// #5990: the schedd's one GitHub read client. One GraphQL call refreshes every tracked issue (state, labels, milestone,
// comment count, updatedAt), a TTL cache serves the last good value when gh fails, and every spawn is counted against a
// per-pass budget. Writes (labels, comments, PRs) never come through here.

const NETWORK_RE = /could not resolve host|no such host|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|network is unreachable|connection (reset|refused|timed out)|i\/o timeout|timed out|tls handshake|unexpected EOF|error connecting to|dial tcp/i;

/** True when `e` is gh failing to reach GitHub (not a lane or content problem). */
export function isNetworkError(e) {
  if (!e) return false;
  if (typeof e.code === "string" && /^(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/.test(e.code)) return true;
  return NETWORK_RE.test(`${e.message ?? e} ${e.stderr ?? ""}`);
}

export const READER_TTL_MS = 30_000;
export const READER_CHUNK = 100;
export const READER_PASS_BUDGET = 60;

const FIELDS = "number state stateReason updatedAt milestone{title} labels(first:100){nodes{name}} comments{totalCount}";
export const buildQuery = (numbers) => `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${numbers.map((n) => `i${n}:issue(number:${n}){${FIELDS}}`).join(" ")}}}`;

export function makeGhReader({ gh, repo, ttlMs = READER_TTL_MS, chunk = READER_CHUNK, passBudget = READER_PASS_BUDGET, now = Date.now, log = () => {} }) {
  const [owner, name] = String(repo).split("/");
  const cache = new Map(); // n -> { at, state, stateReason, labels, milestone, comments, updatedAt }
  const tracked = new Set();
  let inflight = null, spawns = 0, passSpawns = 0, graphql = 0;
  /** Every gh spawn of the read path goes through here (counted). */
  const spawn = (args, opts) => { spawns++; passSpawns++; return gh(args, opts); };
  const store = (n, v) => cache.set(Number(n), { ...v, at: now() });
  const fetchChunk = async (numbers) => {
    graphql++;
    const out = JSON.parse(String(await spawn(["api", "graphql", "-f", `query=${buildQuery(numbers)}`, "-F", `owner=${owner}`, "-F", `name=${name}`])));
    const repoData = out?.data?.repository;
    if (!repoData) throw new Error(`graphql returned no repository: ${String(out?.errors?.[0]?.message ?? "").slice(0, 120)}`);
    for (const n of numbers) {
      const i = repoData[`i${n}`];
      if (!i) continue;
      store(n, { state: i.state, stateReason: i.stateReason, labels: (i.labels?.nodes ?? []).map((l) => l.name), milestone: i.milestone?.title ?? null, comments: i.comments?.totalCount ?? 0, updatedAt: i.updatedAt });
    }
  };
  /** One GraphQL call per `chunk` issues. Throws on the first failed chunk; the cache keeps the last good values. */
  const refresh = async (issues) => {
    const list = [...new Set((issues ?? []).map(Number).filter(Number.isInteger))];
    for (const n of list) tracked.add(n);
    for (let i = 0; i < list.length; i += chunk) await fetchChunk(list.slice(i, i + chunk));
  };
  const fresh = (e) => e && now() - e.at < ttlMs;
  /** Cached entry for `n`, refreshing every stale tracked issue in one batch; a failed refresh serves the stale entry. */
  const get = async (n) => {
    n = Number(n);
    tracked.add(n);
    if (fresh(cache.get(n))) return cache.get(n);
    if (passSpawns >= passBudget && cache.has(n)) { log(`gh-reader: spawn budget ${passBudget} reached; serving cache for #${n}`); return cache.get(n); }
    try {
      inflight ??= refresh([...tracked].filter((t) => !fresh(cache.get(t)))).finally(() => { inflight = null; });
      await inflight;
      if (!cache.has(n)) await refresh([n]); // a refresh begun before `n` was tracked
    } catch (e) {
      if (cache.has(n)) return cache.get(n);
      throw e;
    }
    const e = cache.get(n);
    if (!e) throw new Error(`issue #${n} not found in ${repo}`);
    return e;
  };
  return {
    refresh, get, spawn,
    labels: async (n) => (await get(n)).labels,
    milestone: async (n) => (await get(n)).milestone,
    beginPass() { passSpawns = 0; },
    endPass(label = "pass") { log(`gh-reader: ${label} spawns=${passSpawns} budget=${passBudget} graphql=${graphql} cached=${cache.size}`); },
    stats: () => ({ spawns, passSpawns, graphql, cached: cache.size }),
  };
}
