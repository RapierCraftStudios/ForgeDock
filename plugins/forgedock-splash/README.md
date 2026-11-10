# forgedock-splash

A startup splash for ForgeDock users in Claude Code. When an interactive terminal session starts, the row above the prompt plays a short (about 6.5 s) scene: the ForgeDock "F" mark is forged white-hot and cools to chrome, Clawd walks in under the top bar, jumps and bonks it, sparks fly and a shine ring crosses the mark, the `F O R G E D O C K` wordmark types in, and it settles on `» supercharged` before the row clears.

It changes nothing else: no commands, prompts, tools or settings.

## Behaviour

- Plays on a fresh launch only: not after `/clear` and not on a resumed session.
- Stops at once when you submit a prompt, and skips itself when the terminal is narrower than 56 columns or shorter than 9 rows.
- Follows Claude Code's `theme` setting: a darker palette on light themes.
- Draws nothing in `claude -p` or SDK runs.

## Install and turn off

`npx forgedock` installs it by default at user scope (through a local `forgedock-local` marketplace under `~/.forge`) when the `claude` CLI is on PATH, and refreshes it on every re-run. Skip it with `npx forgedock --no-splash` or `FORGEDOCK_NO_SPLASH=1`; a plugin you disabled is never re-enabled. `npx forgedock uninstall` removes it.

Manual install:

```
/plugin marketplace add RapierCraftStudios/ForgeDock
/plugin install forgedock-splash@forgedock
```

Turn it off with `/plugin disable forgedock-splash` (or uninstall it).

It uses Claude Code's plugin hooks module API (early access); on Claude Code versions without it, the plugin does nothing.
