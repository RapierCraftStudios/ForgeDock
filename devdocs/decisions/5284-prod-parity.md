# 5284 — production parity beyond ingress

Four AlterLab defects passed the lane because the checks never exercised production topology: ISR runtime, Traefik routing, migration role vs app role, shared env file scope. #5087 covered route reachability only.

- forge.yaml `topology.prod_parity` is a block map `{path glob: command | "note: how to verify"}` (shape of `verification.coupled_files`, #5079). The engine stays repo-agnostic (#1347): it matches changed files and runs the repo's command.
- A command runs once with the matching paths; non-zero or cannot-start blocks in `precheck`. A note needs a `parity` entry with a justification in the result file. Deterministic, 0 LLM calls.
- Default-off: no key, no check. The key is activated per repo (first cohort: AlterLab).
- Rejected: an LLM judging parity (a path match is exact); a typed schema per fact class (a glob plus command covers all four and future classes); migrating `route_reachability` (kept unchanged).
