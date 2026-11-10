# Replay time-lapse

`forgedock replay --timelapse <batch-id|epic-number> [--repo owner/repo] [--out dir] [--format gif|mp4] [--duration 30-90] [--events file]`

Renders a time-lapse of a recorded batch or epic: issues appearing, lanes starting, PRs opening and merging, the release gate passing, with a clock and a running cost counter. The video is 30-90 s (default 60) however long the real run took.

- **Data**: the local lifecycle event log (`~/.forge/events/<owner>_<repo>.jsonl`, see `docs/EVENTS.md`; `FORGE_EVENTS_DIR` or `--events` override). A batch id takes its issues from the batch plan (`~/.forge/batches/<id>/plan.json`); an epic number takes the `#N` references in the epic body.
- **Read-only**: no model call and no GitHub writes. The only `gh` calls are an `issue view` read for an epic, and the runner refuses anything else.
- **Output** (`--out`, default `timelapse-<id>/`): `frames/frame-NNNN.txt`, `timelapse.tape` and `timelapse.json`. When `vhs` is on PATH the tape is rendered to `timelapse.gif` or `timelapse.mp4`; otherwise the command is printed (`cd <out> && vhs timelapse.tape`). Nothing is installed.
