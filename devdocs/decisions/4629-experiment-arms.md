# 4629: live experiment arms and the shared bench record

- The experiment is declared in forge.yaml `experiment:` (flat keys: the parser has one nesting level, no arrays).
- The arm is sha1(id:issue) over the ratio weights, not random: resumes and re-runs keep their arm.
- `arm` and `experiment` are tagged by the lean lane only; legacy-engine runs carry none and are not counted.
- `scripts/bench-lightlane.mjs aggregate` and `scripts/eval-gate-scorecard.mjs` add a `record` key shaped `forge.bench.v1` (`bin/experiment.mjs` `benchRecord`); their existing keys and exit codes are unchanged.
- Closing the experiment follow-up from met targets (R5) waits for the part 1 checks (#4626); stats exposes `targets_met` for it.
