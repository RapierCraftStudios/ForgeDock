# 5087 — route reachability and the route-handler reviewer trigger

AlterLab #38241 added Next.js handlers under `app/(site)/api/v1/agent/signup/*`. Every unit test passed, but the production Traefik api-router (`generate-traefik-config.sh`) sends `/api/v1/*` to FastAPI, so the new routes were unreachable. An app-level rewrite does not change where the ingress sends a path.

- forge.yaml `topology.route_reachability` is a repo-supplied command. `bin/lean/routecheck.mjs` maps the route handlers a diff adds to URL paths (route groups `(x)` and slots `@x` dropped, `[param]` kept) and runs the command with them as arguments. A non-zero exit is a blocking `conformance.unimplemented` (`kind: route_unreachable`) in `precheck`. The engine core stays repo-agnostic (#1347). Without the key there is no check and nothing new blocks.
- `scripts/review-roster.sh` adds the Infra reviewer (trigger `route-handler`) for `app/**/route.*` and `pages/api/**` paths, even when no infra file changed. The Infra rubric asks the reviewer to confirm that the production ingress delivers the path to the service.
- `validateContract` rejects a plan decision that replaces an e2e/integration check with mocked tests, unless a `forge-probe` acceptance probe is declared. The tag-based #4726 `[type:e2e]` rule is unchanged.
