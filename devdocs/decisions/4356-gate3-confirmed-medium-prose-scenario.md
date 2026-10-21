---
issue: 4356
status: fresh
anchor: scripts/review-finalize.sh
created: 2026-10-21
---

# ADR: Gate 3 keeps CONFIRMED MEDIUM and reads the scenario from the prose

## Context

Gate 3 (concrete failure, `/review-pr` §6B.4) demoted every MEDIUM/LOW/INFO finding to `NOTE no-scenario` unless its section held a bold `**Failure scenario**` line. Confidence did not matter, and the classifier never saw the finding. In the 1.30.0 staging review, 19 of 24 findings were demoted only for the missing field, including real CONFIRMED MEDIUM bugs (#4343, #4344).

## Decision

- Gate 3 never demotes a CONFIRMED MEDIUM (case-insensitive). CRITICAL/HIGH stay exempt at any confidence. The kept finding goes through `classify-finding.sh` (MEDIUM CONFIRMED -> ISSUE) and is filed with its agent and prose as evidence.
- Scenario detection reads the prose. A `**Failure scenario**` anywhere on a line counts, as before. So does a line that starts, after list/quote/bold markup, with a `failure scenario`, `scenario`, `repro`, `reproduction` or `steps to reproduce` label followed by `:` or a closing `**`. The content may sit on the next non-blank line.
- The damper stays: LIKELY/POSSIBLE MEDIUM, and every LOW/INFO, with no scenario label are still demoted. No marker, count or `FORGE:NOTE_DISPOSITION` field changed.

## Alternatives

- Free-text scenario heuristics: would make "no scenario anywhere" undecidable and erase the damper.
- Moving the rule into `classify-finding.sh`: Gate 3 is a provenance gate in extract, and demoted findings never reach the classifier.
