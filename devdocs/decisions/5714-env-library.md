# 5714: environment library (Forge CI W1)

## Context

Lanes, CI jobs and deploy image builds each reinstall the same dependency trees. Measured on a production consumer
repo: lane dependency setup 62.7 s as a cross-mount copy and 13.0 s as per-file hardlinks for 19,677 files / 3.6 GB;
self-hosted CI installs 383 s per job; setup is 17% of CI minutes. depcache (#4220) shares installs between lanes of one
host, per ecosystem, built inside the first lane that misses. #5696 put the lane worktree on the cache volume
(`/cache/work/<id>`), which removed the EXDEV copy.

## Choice

One snapshot per environment key, built once outside any job, consumed three ways. Code: `bin/env/env.mjs`
(pure functions + local store), `bin/env/cli.mjs`, a hook in `bin/lean/depcache.mjs`, a helper container in
`bin/pool/agent.mjs`.

**Key.** 16 hex of sha256 over: platform, base image, sorted `execution.lane_tools`, toolchain pin files (`.nvmrc`,
`.node-version`, `.python-version`, `.tool-versions`, `.go-version`, `rust-toolchain[.toml]`), and per ecosystem the
content of the files depcache's own key hashes (lockfile, every tracked `package.json`, workspace and package-manager
config, `pyproject.toml`). Detection is `makeDepCache().describe` (new), so npm, pnpm, yarn, uv and poetry at the root
or one level down are covered exactly as depcache covers them; go/cargo arrive when depcache gets them. No tool is run:
a CI job, the dispatcher and the pool host compute the same key from a checkout. Resolved tool versions are recorded in
the manifest, not hashed; the image is hashed instead (it pins them).

**Manifest.** `{v, key, repo, ref, commit, prefix, ecosystems[{eco,dir,lock}], trees[], toolchain{pins,resolved},
lane_tools, image, platform, size_bytes, files, created}`.

**Stores.** Local directory (`<FORGE_ENV_ROOT>/<key>/{manifest.json, tree/, ready/<id>/, last-used}`) and OCI image
(`<env.snapshots.image>:<key>`, built from a generated `Dockerfile.env`: base image, lane_tools recipes, `COPY` of the
hashed inputs, the frozen installs at the prefix, the manifest at `<prefix>/.forge-env.json`). Local has
`has/manifest/publish/stage/claim/list/gc/locate`; OCI has `has/locate/recipe`. GC (`planGc`): per repo keep the newest
`keep` by last use, drop older ones and anything unused for `max_age_days`, never a repo's newest.

**Lanes (the structural part).** The store is `/cache/env`, on the same volume as the lane worktree
(`/cache/work/<id>`, #5696), so no mount is added. Per file work is removed, not just the copy:

1. The pool agent starts a helper container (`cs-envbuild-<repo>`, lane image, cache volume) after a launch whose spec
   carries `env_snapshots`, at most once per 5 min per volume. It runs `forgedock env ensure`: clone the ref from the
   repo's bare mirror in the volume into `/work/env`, compute the key, build if missing (the repo's own frozen installs
   via `depcache.prepare({publish: false})`), stage `ready` hardlink copies, GC. It is never awaited by a launch.
2. In the lane, `depcache.prepare` (only with `FORGE_ENV_SNAPSHOTS=1`) computes the worktree's key and claims: one
   `rename` to take a staged copy, one `rename` per tree into the worktree. `planClaim` picks `rename` (same device and
   a staged copy), `link` (same device, none staged) or `copy` (different devices, reported as such).
3. Trees are built at the fixed prefix `/work/env`; the claim makes `/work/env` a symlink to the lane worktree, so
   absolute paths baked into the trees (pnpm bin shims, venv shebangs, editable installs) resolve to the lane's files.
   No bin rewrite and no repair pass, which is what the 13.0 s hardlink figure still paid.
4. depcache's normal loop then runs: it finds the trees, applies its completeness check (#5590) and reports them as
   `hit` with reason `env snapshot (<mode>)`. A broken tree is rebuilt by depcache as any broken tree is.

A lane whose lockfiles differ from every snapshot gets no claim and installs exactly as today, still on one volume.

**CI.** A job computes the key (`forgedock env key --store oci`) and runs in `<image>:<key>`;
`templates/github-actions/forge-env/action.yml` verifies the image's key and puts the checkout at the prefix (or links
the trees). A key with no image falls back to the job's normal install. **Deploy images** use
`FROM <image>:<key> AS env` and `COPY --from=env /work/env/<tree>`.

**Proxies and git mirror.** `pool/services/docker-compose.yml` (verdaccio, proxpi, apt-cacher-ng, a git:// mirror),
loopback bind by default, not deployed by this change. `env.proxies.{npm,pypi,apt,git}` become lane env through
`proxyEnv` (`npm_config_registry`, `YARN_NPM_REGISTRY_SERVER`, `PIP_INDEX_URL`, `UV_DEFAULT_INDEX`, `FORGE_APT_PROXY`,
`FORGE_GIT_MIRROR`); the entrypoint writes the apt proxy file.

## Config

`env.snapshots.{enabled (false), store (local|oci), keep (3), max_age_days (14), ready (2), base_image, image}` and
`env.proxies.{npm, pypi, apt, git}`. Off: no spec field, no lane env, no helper, no import of `bin/env` in a lane; unit
tests pin the depcache result rows and the launch args.

## Failure modes

- Helper cannot build (registry needs a secret, install error, mirror not cloned yet): no snapshot; lanes install as today.
- Staged copies run out: the claim hardlinks from `tree/` (per-file), still without a repair pass.
- Store on another filesystem: mode `copy`, visible in `DEPS_PREPARED`.
- Prefix already a real directory, or trees already in the worktree: no claim.
- Two lanes race for one staged copy: the directory rename is atomic; the loser takes the next or links.
- A tool that compares its real working directory with the build prefix would not accept the alias. None of the five
  package managers does on a frozen tree; depcache's completeness check is the guard, and the switch is per repo.

## Measured

`node bin/env/bench.mjs` on the dev host (ext4, NVMe), synthetic 19,677 small files, three runs: claim of a staged copy
1 ms each (rename); claim with nothing staged 507–1057 ms (hardlinks); staging 583–1290 ms on the pool side. Not yet
measured on a pool host or with real trees: after a consumer turns the switch on, read `LANE_SETUP_TIMING` step `deps`
and `DEPS_PREPARED` rows with reason `env snapshot (rename)` from lane run logs. Target: at most 2 s.

## Rejected

- **Overlay mount of the snapshot under the worktree** (docker `local` volume with `type=overlay`): O(1) too, but the
  mount point must exist before `git clone` / `git worktree add`, both of which refuse a non-empty directory; a rename
  out of a lower layer needs `redirect_dir=on`; and installs that miss would hardlink across the overlay boundary (EXDEV
  again).
- **Symlinked `node_modules` into a shared read-only snapshot**: breaks workspace links (they are relative to the real
  path) and anything that writes under `node_modules/.cache`.
- **A `current` pointer per repo**: the store is content addressed; a lane finds its snapshot by its own key, so a
  stale pointer cannot hand a lane the wrong trees.
- **Hashing resolved tool versions**: needs the tools on every machine that computes a key (CI key job, dispatcher).
