# 5917: lanes cannot rewrite host-global tool config

A builder ran `poetry config virtualenvs.create false` and poisoned the host poetry config. The lane env now redirects
`POETRY_CONFIG_DIR`, `npm_config_userconfig`, `PIP_CONFIG_FILE`, `UV_CONFIG_FILE` and `GIT_CONFIG_GLOBAL` into
`<run TMPDIR>/hostconfig` (`bin/lean/hostconfig.mjs`, merged beneath the engine's own keys in `laneEnv()`).

- Nothing is seeded from the host; the git global file `[include]`s the host's so identity and helpers still apply.
- A permission deny list was rejected: it misses validate commands, scripts and shell indirection.
- Preflight reports a host poetry config with `virtualenvs.create = false` as an env defect (`hostEnvDefects`).
- Deferred: classifying host-only validate failures as environment (needs a clean-env rerun path).
