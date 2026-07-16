# Security Policy

## Supported Versions

ForgeDock is distributed as an npm package. We support the latest published version on npm. If you are running an older version, please update to the latest before reporting a vulnerability.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a vulnerability in ForgeDock — including issues that could allow malicious repositories to execute arbitrary commands, expose credentials, or bypass intent guards — please report it privately:

1. **GitHub Security Advisories (preferred)**: Use [GitHub's private vulnerability reporting](https://github.com/RapierCraftStudios/ForgeDock/security/advisories/new) to submit a report confidentially.

2. **Email**: If you prefer, email the maintainers via the contact listed on the [GitHub profile](https://github.com/RapierCraftStudios).

### What to include

- A description of the vulnerability and its potential impact
- Steps to reproduce (include relevant `forge.yaml` config, command invocation, and Claude Code version)
- Whether you have a proposed fix

### What to expect

- **Acknowledgement**: Within 48 hours
- **Assessment**: Within 5 business days
- **Fix timeline**: Coordinated with you based on severity

We will credit you in the release notes unless you prefer to remain anonymous.

## Scope

ForgeDock is a set of markdown command specs that run inside Claude Code. The primary security surface areas are:

- **`bin/forgedock.mjs`** — the npm installer that symlinks commands into `~/.claude/commands/` (always global; `--global` is accepted for backward compatibility but has no effect)
- **`commands/*.md`** — prompt specs that instruct Claude Code agents to run `gh`, `git`, and shell commands
- **`forge.yaml`** — project configuration that influences which repos and branches agents target

Vulnerabilities in Claude Code itself should be reported to [Anthropic](https://www.anthropic.com/security).
