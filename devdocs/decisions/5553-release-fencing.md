# 5553: lease-epoch fencing of release side effects

Context: #5550 built the ledger and lease; a zombie host could still merge or dispatch (epic #5549, I5/I7).

Decisions:
- `fenced()` (bin/lean/release-fence.mjs) checks, writes the intent naming the epoch, then checks again before acting: the second read closes the window between the first read and the intent write. Fence off (unmanaged release) means no ledger call and unchanged argv.
- Unreadable `_active` refuses (I5). A refusal ends the run as `refused`, never a retry loop.
- The lease is taken after `release-pr`, because the heartbeat comment needs an issue-like target and the release PR is the only one that exists; no tracking issue yet.
- Epoch carriers: `Forge-Epoch` merge trailer, `forge_epoch` dispatch input checked by publish.yml's first step, `epochMarker` for comments. Effects stay idempotent by observing GitHub (a MERGED PR is not merged again), so intents are not used to skip effects.
- The workflow reads branch `_active`, the name `release-ledger.mjs` actually writes (`ACTIVE`), not `forge-ledger/_active` from the design text.
- Rollback, flag flip and intake release have no code yet: they use `fenced()` when added. There is no conductor in this repo.
