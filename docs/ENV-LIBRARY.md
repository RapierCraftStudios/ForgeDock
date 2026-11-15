# Environment library

Install a repo's dependencies once per lockfile change and reuse the result in lane sandboxes, CI jobs and deploy image
builds. Off by default; turned on per repo in `forge.yaml`.

A snapshot is the set of trees a frozen install leaves (`node_modules` directories, `.venv`) for one **environment
key**: a hash of the lockfiles and manifests, the toolchain pin files, `execution.lane_tools`, and the base image. The
key needs no tools to compute:

```bash
forgedock env key            # 16 hex characters
forgedock env key --json     # plus ecosystems, pins, lane tools, image
```

Supported ecosystems are the ones the dependency cache detects: npm, pnpm, yarn (node-modules linker), uv and poetry,
at the repo root or one level down (`web/`, `services/<name>/`, `packages/<name>/`, `apps/<name>/`).

## How to turn it on

```yaml
env:
  snapshots:
    enabled: true      # default false
    store: local       # local (pool cache volume) | oci (container image by key)
    keep: 3            # snapshots kept per repo
    max_age_days: 14   # unused snapshots older than this are removed (a repo's newest always stays)
    ready: 2           # staged copies kept ready for lanes
```

Remove the block (or set `enabled: false`) to turn it off. Nothing else changes with it off.

## Lane sandboxes (pool)

With `enabled: true` and a pool provider, each launch tells the pool agent to keep the repo's snapshot current. The
agent runs a short helper container beside the lanes (never inside one) that reads the repo's git mirror in the cache
volume, builds the snapshot for the base ref's lockfiles if it is missing, and stages `ready` copies. A lane whose
lockfiles match claims a staged copy with a directory rename; its run log shows

```
Dependencies (pnpm <key>): hit (env snapshot (rename)) in 0.0s
```

`(link)` means no staged copy was ready (one hardlink per file); `(copy)` means the store and the worktree are on
different filesystems, which the pool's own mounts never produce. A lane that changes a lockfile gets no snapshot and
installs as before. If the helper cannot build (for example a registry that needs a credential the helper does not
have), there is no snapshot and lanes install as before.

Agent settings (optional, agent config): `env_build_cpus` (2), `env_build_mem_gb` (4).

Pool lanes always use the store in their cache volume. `store` only selects what `forgedock env build` writes, so a repo
can set `store: oci` for CI and still get snapshots in its lanes. Run `forgedock env key` in a git checkout: the tracked
`package.json` files are part of the key.

## CI jobs

Use the `oci` store so jobs can pull the snapshot as their container image:

```yaml
env:
  snapshots:
    enabled: true
    store: oci
    base_image: ghcr.io/<owner>/<ci-base>:<tag>   # the image your jobs run in today (toolchain installed)
    image: ghcr.io/<owner>/<repo>-env             # where snapshots are pushed; the key is the tag
```

Build and push on a build host when the key changes on the base branch, never inside a test job:

```bash
forgedock env build --out .forge/env/out     # writes Dockerfile.env, manifest.json, build.sh; runs no installer, no docker
bash .forge/env/out/build.sh                 # docker build + push, from the repo root
```

In the workflow, one small job computes the key and the image; test jobs run in it. Copy
`templates/github-actions/forge-env/` to `.github/actions/forge-env/`.

```yaml
jobs:
  env:
    runs-on: ubuntu-latest
    outputs:
      key: ${{ steps.k.outputs.key }}
      image: ${{ steps.k.outputs.image }}
    steps:
      - uses: actions/checkout@v4
      - id: k
        run: |
          key=$(npx --yes forgedock env key --store oci)
          ref="ghcr.io/<owner>/<repo>-env:$key"
          if docker manifest inspect "$ref" >/dev/null 2>&1; then image="$ref"; else image="ghcr.io/<owner>/<ci-base>:<tag>"; fi
          { echo "key=$key"; echo "image=$image"; } >> "$GITHUB_OUTPUT"
  test:
    needs: env
    runs-on: ubuntu-latest
    container: ${{ needs.env.outputs.image }}
    steps:
      - uses: actions/checkout@v4
      - id: deps
        uses: ./.github/actions/forge-env
        with: { key: "${{ needs.env.outputs.key }}" }
      - if: steps.deps.outputs.hit != 'true'
        run: npm ci                      # your normal install, unchanged
      - run: npm test
        working-directory: ${{ steps.deps.outputs.workdir }}
```

A key with no image (a PR that changes a lockfile) runs in the base image with the normal install, so the same checks
run either way. `mode: prefix` (default) copies the checkout over `/work/env` and reports it as `workdir`; `mode: link`
symlinks the trees into the workspace and suits single-package repos without workspace links.

Python projects: the image installs dependencies only (`uv sync --frozen --no-install-project`,
`poetry install --sync --no-root`). If your tests import the project as an installed package, add that install as a
step.

## Deploy image builds

```dockerfile
ARG ENV_IMAGE            # <env.snapshots.image>:<key>
FROM ${ENV_IMAGE} AS env
FROM node:22-slim
WORKDIR /app
COPY --from=env /work/env/node_modules ./node_modules
COPY . .
```

Pass `--build-arg ENV_IMAGE=<image>:$(forgedock env key --store oci)`. The dependency layer is then identical across
builds until a lockfile changes.

## Package proxies and git mirror (optional)

`pool/services/docker-compose.yml` runs caching proxies for npm (verdaccio), PyPI (proxpi) and apt (apt-cacher-ng) and a
read-only git mirror. They have no authentication and bind to loopback by default; set `FORGE_PROXY_BIND` to a private
address reachable from pool hosts and runners. They serve public packages and public repos only.

```yaml
env:
  proxies:
    npm: http://<host>:4873
    pypi: http://<host>:3141/index
    apt: http://<host>:3142
    git: git://<host>:9418
```

Each key is independent; absent keys change nothing. Lanes then get:

| Key | Lane environment |
|---|---|
| `npm` | `npm_config_registry`, `YARN_NPM_REGISTRY_SERVER` (and `YARN_UNSAFE_HTTP_WHITELIST` for an http URL) |
| `pypi` | `PIP_INDEX_URL`, `UV_DEFAULT_INDEX`, `UV_INDEX_URL` (and `PIP_TRUSTED_HOST`, `UV_INSECURE_HOST` for an http URL) |
| `apt` | `FORGE_APT_PROXY`; the lane image writes `/etc/apt/apt.conf.d/01forge-proxy` |
| `git` | `FORGE_GIT_MIRROR`; not applied automatically (lanes already keep a bare mirror in their cache volume) |

CI runners set the same variables in the job `env:`. For checkouts, a runner can borrow objects from the mirror:
`git clone --reference-if-able` against a local clone of `git://<host>:9418/<owner>/<name>.git`. poetry reads its
sources from `pyproject.toml` and is not redirected by these variables.

## Commands

| Command | What it does |
|---|---|
| `forgedock env key [--json] [--store oci] [--lane-tools a,b] [--image ref]` | Print the checkout's key. Exit 1 when no supported lockfile is found. |
| `forgedock env build [--store local\|oci] [--out dir]` | Write the recipe and manifest for the key. Runs no installer and no docker. |
| `forgedock env build --apply` | Local store only: run the frozen installs in the checkout and publish. For a build container, not a job. |
| `forgedock env stage [--key k] [--count n]` | Stage ready copies of a snapshot (pool host). |
| `forgedock env status [--json]` | List snapshots in the local store (`FORGE_ENV_ROOT`, default `~/.forge/env`). |
| `forgedock env gc [--apply] [--keep n] [--max-age-days d]` | Plan, or with `--apply` perform, removal by count and age. |

## Measuring

- Lanes: `LANE_SETUP_TIMING` step `deps` and `DEPS_PREPARED` (`reason: "env snapshot (rename)"`) in lane run logs.
- This machine's filesystem: `node bin/env/bench.mjs --files 19677`.
- CI: the install step's duration on a hit (skipped) against a miss.
