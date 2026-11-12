# Vendored js-yaml (#5551)

- Package: js-yaml 4.1.0 (MIT, see LICENSE), file `dist/js-yaml.mjs`, unmodified.
- Source: `npm pack js-yaml@4.1.0`
- sha256 of js-yaml.mjs: 16f210b939b359b6ec8dde581eb62c157185711dc7b719b33779c43db5c31a91
- Used only by `bin/lean/release-config.mjs` (`.forge/release.yaml`, JSON_SCHEMA, duplicate keys throw).
- To bump: re-vendor the new file, update version and sha256 here, run `bin/lean/release-config.test.mjs`.
