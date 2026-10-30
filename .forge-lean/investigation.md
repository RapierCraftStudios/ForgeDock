**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: medium (missing building block for the prod-watch epic #4768; no existing behaviour broken)
**Task Type**: feature

### What Was Claimed
Add `bin/lean/prodwatch-sources.mjs`: a normalised signal shape `{id, source, title, severity, owner, first_seen, last_seen, body, query?}`, `parseSources(cfg)` for `prod_watch.sources`, `runAdapter(source, io)`, and memo/alertmanager/sql/prometheus normalisers. Adapters run only declared `list`/`read`/`run` through `io.exec`; `close` is reachable only via a separate `closeSignal()` that needs an audit record. Tests use injected exec fixtures.

### What We Found
- `git ls-files | grep -i prodwatch` is empty, and no `prod_watch` reference exists in the repo. The module is absent.
- Pattern to copy: bin/lean/issuewatch.mjs:1-12 (pure functions, injected `io`, no LLM, SPDX header) and :39 `parseWatches`, which hand-parses forge.yaml because parseForgeYaml reads one nested level. Flow maps such as `{ list: "...", close: "..." }` are handled by `scalar` at :27-33 (not exported; it splits on commas, so quoted commands with commas would break). `parseSources(cfg)` takes an already-parsed object, so it avoids this.
- The #4768 config example has `list`/`read`/`close` with `{id}`/`{issue}`/`{reason}` placeholders and `run` + `queries`. Commands contain shell quoting (ssh '...'), so substituted values need strict validation.
- The enumerating tests named in the brief (telemetry-seam, batch, checks, conformance, context, drift, execution, fixround) do not reference issuewatch or gatewatch (grep -l empty). Only they list unrelated names, so a new sibling file does not break them.
- devdocs/index.yaml:130 maps `bin/lean/*` to devdocs/modules/lean.md, and scripts/check-devdocs-freshness.sh needs that dossier touched when a non-test bin/lean file is added. The #4767 precedent (86becc861) edited devdocs/modules/lean.md:2129 and docs/CONFIG.md.

### Root Cause
Feature absent. Prod-watch (#4768) has no signal-ingestion layer; siblings #4834-#4838 depend on its normalised shape.

### Affected Files
- bin/lean/prodwatch-sources.mjs (NEW)
- bin/lean/prodwatch-sources.test.mjs (NEW)
- devdocs/modules/lean.md (one sentence under the issuewatch paragraph, for the freshness check)
- Enumerating tests: none need a list change (verified by grep above); not touched.

### Sibling Sweep
Same defect class (a command-running adapter must not allow writes): bin/lean/issuewatch.mjs shells out only via injected `io.gh`; bin/lean/gatewatch.mjs is read-only. There is no shared exec-allowlist helper, so the new file defines its own. Placeholder injection into shell commands is the main risk; `{id}` must be restricted to `[A-Za-z0-9._:-]`. No other sibling to fix.

### History
No prior prodwatch code. Builds on #4765 (issuewatch.mjs, 2245e525e) and #4767 (86becc861 release mode, 94e086fca). Parent #4768 was closed not_planned on GitHub while its children remain open; the issue and siblings are still live.

### Recommendation
New pure module, ESM, no deps:
- `normalizeSignal(raw, source)` returns the exact 8 fields plus optional `query`. Severity is coerced to `P0..P3|unknown`, timestamps to ISO or null, body capped at a fixed length.
- `parseSources(cfg)` accepts `cfg.sources` or `cfg.prod_watch.sources`. It infers kind: `list`+`read` = memo; `run`+`queries` = sql; `kind:` explicit for alertmanager (command returns v2 alerts JSON) and prometheus (`run`, `queries` with `{name, expr, threshold, op}`). It throws on unknown keys, a missing required command, or a non-string command.
- `runAdapter(source, io)` returns `{signals, errors}`. The only exec calls are `source.list`, `source.read` (id substituted) and `source.run` (query substituted). It never touches `close`. `io.exec` is `(cmd) => {code, stdout}`.
- Per-kind normalisers: memo (list output = lines of ids; read output text or JSON), alertmanager (labels.severity, annotations, startsAt/endsAt fingerprint id), sql (each row becomes a signal, id = query name + row key), prometheus (vector result; signal only when value crosses threshold; `query` set).
- `closeSignal(source, signal, {issue, reason, audit}, io)`: refuses without `source.close`, or without an `audit` record `{by, at, reason}` where `audit.append` was injected. It writes the audit entry BEFORE exec and records the result. It is the only function that execs `close`.
- Read-only enforcement test: an io.exec spy asserts that across all adapters only declared list/read/run strings are exec'd and `close` is never exec'd by runAdapter.
- Fixtures synthetic, no customer data.

### Related Issues
Parent #4768; siblings #4834 (triage), #4835 (governor), #4836 (verification loop, uses closeSignal), #4837, #4838 (runner/CLI, consumes parseSources); precedents #4765, #4766, #4767.
