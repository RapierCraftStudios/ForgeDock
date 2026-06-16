# Contributing to ForgeDock

Thank you for your interest in contributing to ForgeDock. Before you submit a pull request, please read this document carefully — especially the DCO requirement.

## Developer Certificate of Origin (DCO)

ForgeDock is dual-licensed: open-source contributions are licensed under [AGPL-3.0](./LICENSE), and RapierCraft Studios offers a separate commercial license for proprietary use. To support this model, **all contributions must include a DCO sign-off**.

The [Developer Certificate of Origin](https://developercertificate.org/) is a lightweight way for contributors to certify that they wrote (or have the right to submit) the code they are contributing. By signing off, you confirm:

> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I have the right to submit it under the open source license indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best of my knowledge, is covered under an appropriate open source license and I have the right under that license to submit that work with modifications, whether created in whole or in part by me, under the same open source license (unless I am permitted to submit under a different license), as indicated in the file; or
>
> (c) The contribution was provided directly to me by some other person who certified (a), (b) or (c) and I have not modified it.
>
> (d) I understand and agree that this project and the contribution are public and that a record of the contribution (including all personal information I submit with it, including my sign-off) is maintained indefinitely and may be redistributed consistent with this project or the open source license(s) involved.

### Why we require DCO

ForgeDock uses a dual-license model (AGPL-3.0 + commercial). For RapierCraft Studios to offer a commercial license that covers contributed code, we need a clear record of each contributor's intent to grant rights. The DCO provides this record without requiring contributors to sign a separate legal agreement.

### How to sign off your commits

Add a `Signed-off-by:` trailer to each commit using `git commit -s`:

```bash
git commit -s -m "feat: add new pipeline phase"
```

This appends the following to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must match your Git identity. To set them:

```bash
git config user.name "Your Name"
git config user.email "your.email@example.com"
```

### Fixing unsigned commits

If your PR has commits without a `Signed-off-by` line, you can amend them:

**Single commit:**
```bash
git commit --amend -s --no-edit
git push --force-with-lease
```

**Multiple commits (interactive rebase):**
```bash
git rebase --signoff HEAD~N   # N = number of commits to fix
git push --force-with-lease
```

### DCO enforcement

All pull requests are checked by the [DCO GitHub Action](https://github.com/dcoorg/gha-dco). The check must pass before a PR can be merged. Bot accounts (`github-actions[bot]`, `dependabot[bot]`) are automatically exempt.

---

## Getting Started

1. Fork the repository and clone your fork.
2. Create a feature branch from `main` (or the relevant milestone branch).
3. Make your changes, following the [pipeline conventions](./docs/WORKFLOW.md).
4. Sign off all commits with `git commit -s`.
5. Open a pull request — the PR template will remind you.

## Code Style

- Follow existing conventions in the file you are editing.
- Command prompts (`commands/*.md`) use the established pattern documented in [WORKFLOW.md](./docs/WORKFLOW.md).
- No emojis in code or documentation unless they already exist in the file.

## License Headers

All source files must include SPDX license headers. Use the following patterns:

**JavaScript / Node.js (`.mjs`, `.js`):**

Place immediately after the shebang line (if present), otherwise at the top of the file:

```js
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
```

**Markdown (`.md`) — files with YAML frontmatter:**

Place immediately after the closing `---` of the frontmatter block:

```md
---
description: ...
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
```

**Markdown (`.md`) — files without frontmatter:**

Place at the very top of the file:

```md
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
```

**Files that cannot contain comments (`.json`, binary):**

Create a sibling `.license` file with the same name plus `.license` extension (REUSE spec §5.2):

```
bin/github-app-manifest.json.license:

SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
SPDX-License-Identifier: AGPL-3.0-or-later
```

The `AGPL-3.0-or-later` identifier covers the open-source license. A separate [commercial license](./COMMERCIAL-LICENSE.md) is available for proprietary use — see COMMERCIAL-LICENSE.md for details.

## Questions?

Open an issue or start a discussion on GitHub.
