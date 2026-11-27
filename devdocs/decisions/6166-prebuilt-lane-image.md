---
issue: 6166
status: fresh
anchor: bin/pool/lane-image.mjs
created: 2026-11-27
---

# ADR: pool hosts pull a prebuilt lane image; the local build is the fallback

## Context

Every agent self-update rebuilt `forgedock-lane:<version>` from `pool/image/Dockerfile`: 10-20 minutes and a memory spike per host. On WSL hosts with mirrored networking it also failed outright: dockerd and BuildKit dial the AAAA record of Docker Hub and do not fall back to IPv4 (`dial tcp [2600:...]:443: connect: cannot assign requested address`), so the host stayed on the old engine.

## Decision

- `publish.yml` (push to main, after the npm release) builds `pool/image` for `linux/amd64` and pushes `ghcr.io/rapiercraftstudios/forgedock-lane:<version>` and `:r-<recipe hash>` (`versionOf().image`), with the GHA layer cache. The step is `continue-on-error`: the release is already on npm and a host without the image falls back to a build.
- The Dockerfile stamps `forgedock.recipe=<hash>` (build arg `FORGEDOCK_RECIPE`, passed by CI and by the agent's own local build).
- `bin/pool/lane-image.mjs` `provideLaneImage`: image present locally -> done; else `docker pull` the version tag, read the `forgedock.recipe` label, require it to equal the agent's recipe hash, retag as `forgedock-lane:<version>`; a mismatch removes the pulled tag and falls through; any pull failure falls back to the local build (`buildWithRetry`, as before). A custom `cfg.image` is never pulled. Used by self-update and by `ensureImage` at start.
- Repo tool variants (`-t<hash>`) and project layers (`-p<hash>`) still build FROM the local base; a small layer.
- IPv4 fallback: when a pull or build fails with an IPv6 dial error (`cannot assign requested address`, `network is unreachable`, `dial tcp [..]`), the operation is retried once under temporary `/etc/hosts` pins (A records of ghcr.io, pkg-containers.githubusercontent.com, registry-1.docker.io, auth.docker.io, production.cloudflare.docker.com), tagged `# forgedock-ipv4-pin` and removed afterwards (stale ones are also stripped). Chosen over `--network host` plus IPv4 DNS because it needs no daemon or build-flag change and also covers BuildKit's metadata resolution. The agent runs as root; without write access to the hosts file the original error is reported.

## Consequences

- The package must be public so hosts pull anonymously. A new ghcr.io package starts private: set visibility to public once (org Packages, `forgedock-lane`, Package settings). The publish job warns when an anonymous pull fails; until then hosts build locally.
- Only the version tag is pulled; the `r-<recipe>` tag is for audit and manual seeding (`docker pull`, then `docker tag`).
- The agent bundle closure is unchanged: `lane-image.mjs` lives in `bin/pool`.
