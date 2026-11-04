# 5078 — route deferred follow-ups by kind; narrow `owner`

A batch of about 12 lanes filed one issue per deferral, many with a single checkbox and `needs-human` on work the host could do. Follow-ups are now routed by kind, with zero LLM calls (`ownerRoute` in `bin/lean/conformance.mjs`, `owner_route` in `scripts/file-deferred-followups.sh`):

| Kind | Signal | Destination |
|---|---|---|
| Post-promotion / production-verify / rollout-promote | bucket `post-deploy`/`date`, `owner:orchestrator`, `owner:promote:*`, owner why with after promotion/release, rollout, purge | A line in the ONE open rollup (`FORGE:POSTDEPLOY_ROLLUP`, else the lowest open issue labelled `followups.rollup_issue_label`). Never a new issue when one is open. |
| Read-only production data or capture | bucket `host`, or owner why with obs-psql, `*-monitor`, a read-only prod query (no external need) | class `host`: added to the parent's engineering follow-up of the run, else `followup:host` + `host-task`. Never `needs-human`. |
| Truly external | owner otherwise (credentials, spend, an account, a third party, a customer) | ONE aggregate per batch (`FORGE:EXTERNAL_BATCH: <batch>`), `### #<parent>` sections, `needs-human` |
| Engineering | everything else | the parent's open follow-up, else one issue per parent holding all its items |

Why owner is narrowed by routing, not rejected at freeze: the prompt still asks for `owner:promote:<flag>` activation rows and #5020 converts check-less post-deploy rows to `owner:orchestrator`. Rejecting them would cause rework, so the router moves them to the rollup. The script repeats the routing as a safety net for contracts frozen before this change. `bucketProblems` rejects only the unambiguous case: an owner row that is only read-only production access (`use bucket host`).

The read-only production vocabulary is the `prod_monitor` host-capability signals of `bin/lean/execution.mjs`, so the router agrees with lane placement. The per-batch aggregate copies the #4724 rollup pattern (`devdocs/decisions/4724-postdeploy-rollup.md`): trusted lookup, lowest number canonical, post-create duplicate re-check and normalized dedup across parents. The batch report says `follow-ups appended: #N (...)` instead of "issues filed".
