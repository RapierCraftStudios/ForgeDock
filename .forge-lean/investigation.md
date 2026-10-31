**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: high (a failed body read lets writeState overwrite the whole issue body with only FORGE:STATE; the lane then fails its own contract)
**Task Type**: bug

### What Was Claimed
`getBody` in the projector returns "" on any unparseable `gh` output, has no `-R`, and `writeState` has no guard against dropping existing text. #4859/#4861 (authorAssociation field) is a different defect.

### What We Found
- bin/engine/projector.mjs:20-23 `getBody`: `gh issue view N --json body`, no `-R`; `catch { return ""; }`. A thrown `gh` error propagates, but non-JSON stdout is swallowed into "".
- bin/engine/projector.mjs:66-69 `writeState`: `upsertStateBlock(await getBody(issue), index)` then `gh issue edit --body`, no check that the new body keeps the old non-STATE text.
- bin/engine/state.mjs:52-56 `upsertStateBlock("")` returns just the block, so the issue is wiped.
- `makeProjector(io)` (bin/engine/projector.mjs:18) has no repo; callers: bin/lean/effects.mjs:301 (`makeLeanIo({repo})` has repo in scope), bin/engine-cli.mjs:741 and :1042 (`repo` in scope at 1042), bin/engine.mjs:465, bin/hooks/interactive-engine.mjs:157.
- bin/tests/engine-projector.test.mjs:7-24 fakeGh serves `issue view` JSON and handles `issue edit`; the last test (:101) checks writeState keeps reporter text.

### Root Cause
Read failure was modelled as "empty body", and the write path trusts the read unconditionally.

### Affected Files
- bin/engine/projector.mjs: `makeProjector(io, { repo } = {})`; `getBody` passes `-R repo` when known, rethrows on non-JSON or non-string body; `writeState` re-reads and refuses to write when the result would lose non-STATE text.
- bin/lean/effects.mjs:301: pass `{ repo }`. bin/engine-cli.mjs:1042 (and :741 if repo in scope): pass repo.
- bin/tests/engine-projector.test.mjs: new regression tests.
- Enumerating tests (bin/engine dir sibling lists): bin/lean/lean.test.mjs:66 and bin/stats/stats.test.mjs:152. No new file is added in bin/engine, so they should stay green; run them only to confirm.

### Sibling Sweep
- `grep -n '"issue", "view"' bin/engine*.mjs bin/engine/` for other `catch { return "" }` body reads feeding an edit; getTrustedBody (projector.mjs:31) already fails closed and uses `{owner}/{repo}`.
- Other makeProjector callers without a repo keep the old cwd resolution (repo optional) so no behaviour change there.

### History
- 7792c906f introduced the projector; dc29b803d (#3569) added getTrustedBody but left getBody. No prior fix. Incident: #4835 body wiped 2026-10-31T00:16:07Z.

### Recommendation
1. getBody: `args = ["issue","view",N,"--json","body", ...(repo?["-R",repo]:[])]`; `const b = JSON.parse(out).body; if (typeof b !== "string") throw`; no try/catch swallow.
2. writeState: `const body = await getBody(issue)`; compute `next = upsertStateBlock(body, index)`; guard: strip STATE block from `body` (BLOCK_RE or compare `next.replace(block,"")`) and refuse (throw) if non-STATE text of the old body is not still contained in `next`. Because upsert preserves text this guard only trips on bugs, but it is cheap. Throw before any `gh issue edit`.
3. Wire repo from effects.mjs and engine-cli.mjs.
4. Tests: `-R` present on view call; non-JSON view output -> writeState rejects, no `issue edit` call, body unchanged; JSON without string body -> same.

### Related Issues
#4835 (damaged issue), #4859/#4861 (distinct), #3569, #4768.
