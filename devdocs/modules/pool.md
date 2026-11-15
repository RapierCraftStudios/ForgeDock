---
module: pool
glob: "bin/pool/*"
authority: required
token_cost: 300
last_compacted: "2026-11-15"
---

# Module Dossier: bin/pool

Rolling per-module knowledge log. Hard cap: 150 lines.

## Entry 2026-11-15 — CI runner events (#5688, parent #5687)

- `bin/pool/ci-events.mjs` validates and stores events pushed by CI runners; `bin/pool/router.mjs` exposes them.
  - `POST /ci/events` (auth class `ci`: a bearer from router config `ci_tokens[]`, or the fd token). The body is one event or an array of at most 200. The whole array is validated first, so one bad event stores nothing. Replies 202 `{accepted, seq}`.
  - `GET /ci/events?repo=&sha=|pr=&since=<seq>&wait=<s<=60>` (fd token only) long-polls and returns `{events, next}`. Resume with `since=next`.
- Event keys: `type` (`job_started|step_started|step_failed|test_failed|job_finished|runner_unhealthy`), required `repo`, `sha`, `run_id`, `job`, `ts`; optional `pr`, `step`, `exit_code`, `class`, `lines[]` (at most 40, each at most 500 chars), `test{id,file,line,message}`. A missing or malformed key is 400 naming it. Over the line or batch limits is 413. Unknown keys are dropped.
- Ingest stamps `received_at` and a global monotonic `seq` (restored from the NDJSON on restart).
- Memory is a circular ring per (repo, sha) holding 2000 events with a 24 h TTL. Disk is `<state_dir>/ci-events/<repo-key>.ndjson`, appended once per request per repo. It rotates to `<repo-key>.<YYYY-MM-DD>.ndjson` on a new UTC day, and the last 24 h are reloaded on start.
- Bench (`bin/pool/ci-events.test.mjs`): 10 000 events in batches of 200 ingest at well over 2000 events/s, with RSS growth under 50 MB (about 60k events/s and +14 MB on the dev host).
- The router is reached directly on :7710, so no ingress rule is involved.
