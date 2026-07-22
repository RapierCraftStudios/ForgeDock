# ForgeDock Runtime

ForgeDock owns the command surface, workflow protocol, durable state, and user
experience. Agent executables are implementation details behind its execution
backends.

## Backends

| Backend | Purpose |
| --- | --- |
| `native` | Preferred asynchronous local runtime. Keeps engine leases and progress timers active during long phases. |
| `cli` | Compatibility adapter for existing Claude Code installations. |
| `api` | Direct Anthropic API compatibility adapter for CI environments. |
| `auto` | Selects `native`, then `cli`, then `api`. |

Run a workflow:

```bash
forgedock-cli run work-on 42
forgedock-cli run review-pr 123 --backend native
```

Drive an issue through the durable engine:

```bash
forgedock-cli run-issue 42 --lane fast --backend native
```

## Configuration

Set the project default in `forge.yaml`:

```yaml
runtime:
  default: native
```

Environment overrides:

| Variable | Purpose |
| --- | --- |
| `FORGEDOCK_BACKEND` | Overrides `runtime.default`. |
| `FORGEDOCK_RUNTIME_BIN` | Overrides the private executable used by `native`. |
| `FORGEDOCK_MODEL` | Selects a runtime-native model identifier. |
| `FORGEDOCK_CLI_TIMEOUT_MS` | Bounds one agent phase in milliseconds. |
| `FORGEDOCK_PASSTHROUGH_ENV` | Comma-separated extra environment names explicitly exposed to native workers. |

The native runtime is launched with an argv array and `shell: false`. ForgeDock
attaches the authoritative command specification directly, captures bounded
output, normalizes failures into durable engine events, and builds a
least-privilege child environment. GitHub credentials remain available for
workflow state; all other project credentials require explicit opt-in through
`FORGEDOCK_PASSTHROUGH_ENV`.

## Branding

All user-facing output belongs to ForgeDock. Runtime names, logos, command
syntax, and configuration are not surfaced during normal execution. Supported
terminals render `assets/logo-64.png`; other terminals receive the ForgeDock
Chrome-and-Ember ANSI mark or a plain-text fallback.
