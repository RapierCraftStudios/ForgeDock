# Lifecycle Events

ForgeDock emits a small, versioned stream of lifecycle events for outside consumers (dashboards, chat bots, audit logs). It
is derived from the records the engine already produces (the run log and `docs/TELEMETRY.md` inputs): deterministic, no model
call, no consumer required. With no configuration the events go only to a local JSONL file.

## Envelope (v1)

```json
{"schema":"forgedock.event","v":1,"id":"1793012345-9f2c1ab04d7e","type":"pr.merged","ts":"2026-10-26T12:00:00Z","repo":"o/r","issue":9,"pr":40,"run":"core_9_1793012000","cost_usd":0.75,"wall_ms":90000,"data":{"milestone":"m1","code":"ok"}}
```

| Key | Meaning |
|-----|---------|
| `schema` | Always `forgedock.event`. |
| `v` | Schema version (integer). Adding an event type or an optional key keeps `v`; renaming or removing one, or changing a meaning, bumps it. |
| `id` | Unique per event; consumers de-duplicate on it. |
| `type` | One of the types below. |
| `ts` | UTC, second precision. |
| `repo`, `issue`, `pr`, `run` | `owner/name`, issue number, PR number, run id; `null` when not known. |
| `cost_usd`, `wall_ms` | Present on `pr.merged`: the lane's total model spend (sum of every phase attempt's `cost_usd_delta`, else `cost_usd`) and the engine process wall time. |
| `data` | The type's keys (below); a key with no value is omitted. Strings are capped at 200 characters. |

## Event types

| Type | When | `data` |
|------|------|--------|
| `lane.picked_up` | A core lane starts an issue. | `lane`, `path` |
| `contract.frozen` | The lane's contract is frozen. | `hash`, `requirements`, `deferred`, `derived` |
| `pr.opened` | The lane opens its PR (`pr` is set). | none |
| `pr.merged` | The run ends `merged` (`pr`, `cost_usd`, `wall_ms` set). | `milestone`, `code` |
| `probe.passed` / `probe.failed` | A declared acceptance probe is recorded (`forgedock probe`, batch sweep). | `detail`, `fix` |
| `release.promoted` | Reserved (schema only): a fix reached the default branch. | `fix`, `default_branch` |
| `regression.detected` | A windowed post-deploy check failed and filed a regression issue (`forgedock probe --due`, daemon timer; `issue` is the monitored follow-up). | `subject`, `metric`, `detail` |
| `experiment.verdict` | `forgedock stats --experiment <id> --emit-event` found targets `met` or `missed` (`inconclusive` is not emitted; plain `stats` never emits). | `experiment`, `verdict`, `detail` |

`release.promoted` is still reserved: the schema, docs and `promotedEvent` builder exist, and the part that detects promotion
calls `emitEvent(type, data, ctx)` from `bin/engine/events.mjs` when it lands. Nothing emits it yet.

## Local sink

One JSON object per line, appended to `~/.forge/events/<owner>_<repo>.jsonl` (directory override: forge.yaml `events.dir` or
`FORGE_EVENTS_DIR`). The file is a cache of what was emitted on this machine, not a record of truth: GitHub stays the register.

## Webhook (optional)

```yaml
events:
  webhook_url: https://hooks.example.com/forgedock   # https, or http on localhost
  webhook_secret_env: FORGE_EVENTS_SECRET            # NAME of the env var holding the secret (this is the default name)
```

Both the URL and the env var must be set, else nothing is sent. The secret is never read from forge.yaml. Each event is one `POST`
of the envelope JSON with a 5 second timeout, no redirects and no retry; a failed delivery is dropped and never affects the run.

Headers: `X-Forge-Event` (the type), `X-Forge-Timestamp` (unix seconds), `X-Forge-Signature` = `sha256=` + hex
`HMAC-SHA256(secret, "<timestamp>.<raw body>")`. Verify against the raw body and reject old timestamps:

```js
const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
const ok = timingSafeEqual(Buffer.from(sig.replace(/^sha256=/, ""), "hex"), Buffer.from(expected, "hex"));
```

## Guarantees

- Never fails or slows the run beyond the webhook timeout; `FORGE_EVENTS=off` disables the sink and the webhook.
- Ids, counts, codes and costs only: no issue text, diffs, file contents or secrets.
- Contract test: `bin/engine/events.test.mjs` pins the types, keys and the signature algorithm.
