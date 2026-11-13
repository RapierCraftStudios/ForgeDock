# 5563: release rollback ladder

- Rung choice is deterministic: the lowest rung that is configured and fits the trigger. A flag cannot fix a wrong deploy (`livecheck`), so that trigger starts at unit. `--to` only raises the floor.
- Any failure on a rung (health, dispatch, run conclusion, counts) escalates: a failed flag kill tries unit; a failed unit/full goes straight to stop. A partial per-host rollback is never trusted (Q8).
- I8: unit and full rungs are refused across a destructive migration (read from file text in git; unreadable history refuses). The flag rung moves no code and stays allowed. The result is stop (hold, page, incident), not silence.
- The module never runs SQL; the destructive patterns live in `release-config.mjs` so the static test can forbid any SQL verb in `release-rollback.mjs`.
- The revert PR (I10) is built in a throwaway `git worktree`, never in the caller's checkout, and only for unit/full (a flag rung leaves default == live).
- A human `release rollback` takes its own lease epoch so every dispatch carries `forge_epoch`; it refuses while another driver holds a fresh lease.
- Later waves: `--later` ids are held with the existing `hold` control; the conductor (#5564) supplies them.
- Out of scope: `rollback-release.yml` and `service-deploy.yml action=rollback` (AlterLab), conductor, SLI/crash-loop sources.
