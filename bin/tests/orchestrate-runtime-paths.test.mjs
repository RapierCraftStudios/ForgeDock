import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const phase4 = readFileSync(
  new URL("../../commands/orchestrate/phase-4-execution.md", import.meta.url),
  "utf8",
);
const phase3 = readFileSync(
  new URL("../../commands/orchestrate/phase-3-dependency.md", import.meta.url),
  "utf8",
);
const issue = readFileSync(new URL("../../commands/issue.md", import.meta.url), "utf8");
const opencodeDocs = readFileSync(
  new URL("../../docs/OPENCODE.md", import.meta.url),
  "utf8",
);
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("orchestrate runtime helper paths", () => {
  it("resolves lane classification without replacing Claude support", () => {
    assert.match(phase4, /resolve_classify_lane\(\)/);
    assert.match(phase4, /\$HOME\/\.claude\/scripts\/classify-lane\.sh/);
    assert.match(phase4, /\$HOME\/\.opencode\/scripts\/classify-lane\.sh/);
    assert.match(phase4, /\$REPO_PATH\/scripts\/classify-lane\.sh/);
    assert.match(phase4, /CLASSIFY_LANE_SCRIPT=\$\(resolve_classify_lane\)/);
    assert.doesNotMatch(
      phase4,
      /bash ~\/\.claude\/scripts\/classify-lane\.sh/,
    );
  });

  it("uses the resolver for every lane-classification call site", () => {
    const directCalls = phase4.match(/classify-lane\.sh/g) ?? [];
    const resolverCalls = phase4.match(/bash "\$CLASSIFY_LANE_SCRIPT"/g) ?? [];
    assert.equal(resolverCalls.length, 3);
    assert.ok(directCalls.length >= resolverCalls.length);
  });

  it("uses portable parent parsing in both mirrored dispatch paths", () => {
    const parentParser =
      "grep -ioE 'parent[[:space:]:]*#[[:space:]]*[0-9]+|spawned[[:space:]]+from[[:space:]]*#[[:space:]]*[0-9]+'";
    assert.equal(phase4.split(parentParser).length - 1, 2);
    assert.equal((phase4.match(/PARENT_PARSE_STATUS=\$\?/g) ?? []).length, 2);
    assert.equal((phase4.match(/ISSUE_BODY_READ_STATUS=\$\?/g) ?? []).length, 1);
    assert.equal((phase4.match(/FINDING_BODY_READ_STATUS=\$\?/g) ?? []).length, 1);
    assert.match(phase4, /PARENT_CONTEXT_REF/);
    assert.doesNotMatch(phase4, /grep -oP '\(\?i\)parent/);
  });

  it("requires mktemp paths and rejects root-level temp files", () => {
    for (const spec of [phase4, issue]) {
      assert.match(spec, /mktemp/);
      assert.match(spec, /never hand-roll/i);
      assert.match(spec, /\/tmp_invbody_31076\.txt/);
      assert.match(spec, /bypass mode cannot clear|unattended cleanup|interactive deletion approval/i);
    }
  });

  it("resolves affected-file extraction from ForgeDock before the target repo", () => {
    assert.match(phase3, /resolve_extract_affected_files\(\)/);
    assert.match(phase3, /\$FORGE_HOME\/scripts\/extract-affected-files\.sh/);
    assert.match(phase3, /\$REPO_PATH\/scripts\/extract-affected-files\.sh/);
    assert.match(phase3, /AFFECTED_FILES_SCRIPT=\$\(resolve_extract_affected_files\)/);
    assert.match(phase3, /bash "\$AFFECTED_FILES_SCRIPT"/);
    assert.match(phase3, /FILE_SOURCE\[\$NUM\].*=.*error/);
    assert.match(phase3, /affected-file extraction for #\$NUM was inconclusive/);
    assert.doesNotMatch(phase3, /bash scripts\/extract-affected-files\.sh/);
  });

  it("documents OpenCode helper and worktree locations", () => {
    assert.match(opencodeDocs, /FORGE_RUNTIME=opencode/);
    assert.match(opencodeDocs, /\.opencode\/worktrees/);
    assert.match(opencodeDocs, /~\/\.opencode\/scripts/);
    assert.match(opencodeDocs, /Claude keeps its existing engine/);
    assert.match(opencodeDocs, /does not add or modify user-owned OpenCode settings/);
    assert.match(opencodeDocs, /install and uninstall may rewrite `opencode\.json`\s+only/);
    assert.match(opencodeDocs, /migration does not\s+rewrite `opencode\.jsonc`/);
    assert.match(opencodeDocs, /customized commands are\s+preserved/);
  });

  it("keeps README OpenCode install guidance aligned with migration ownership", () => {
    assert.match(
      readme,
      /without changing your provider\s+or user-owned settings\.\s+When migrating an older ForgeDock adapter, it removes\s+only exact ForgeDock-managed legacy entries from `opencode\.json`:/,
    );
    assert.doesNotMatch(readme, /without changing your provider\s+or `opencode\.json`/);
  });

  it("documents event-driven OpenCode DAG dispatch", () => {
    assert.match(phase3, /OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS/);
    assert.match(phase3, /task\(\.\.\., background=true\)/);
    assert.match(phase3, /each injected task-result event/i);
    assert.match(phase4, /OPENCODE_DISPATCH_MAP/);
    assert.match(phase4, /task-result event/i);
    assert.match(phase4, /state="running"/);
    assert.match(phase4, /background=true/);
    assert.match(phase4, /FORGE:DISPATCH/);
    assert.match(phase4, /child_session_id/);
    assert.match(phase4, /fresh OpenCode `task\(background=true\)` continuation/);
    assert.doesNotMatch(phase4, /task\(task_id=.*background=true\)/);
    assert.match(phase4, /do not wait for the slowest sibling/i);
  });

  it("limits cohort edge removal to the diff-verified DONE predecessor", () => {
    assert.match(phase4, /for DESC_PRED in "\$PRED"; do/);
    assert.doesNotMatch(phase4, /for DESC_PRED in \{predecessors_of_DESC\}; do/);
  });

  it("keeps file-overlap edges when either predecessor lookup or diff fetch fails", () => {
    assert.match(phase4, /PRED_PR_EXIT=\$\?/);
    assert.match(
      phase4,
      /if \[ "\$PRED_PR_EXIT" -ne 0 \]; then[\s\S]*?echo "KEEP"[\s\S]*?return/,
    );
    assert.match(
      phase4,
      /if \[ "\$DIFF_EXIT" -ne 0 \]; then[\s\S]*?echo "KEEP"[\s\S]*?return/,
    );
  });

  it("retries an inconclusive cohort re-derivation once without memoizing it", () => {
    assert.match(phase4, /declare -A EDGE_REDERIVE_ATTEMPTS/);
    assert.match(
      phase4,
      /REDERIVE_ATTEMPTS=\$\{EDGE_REDERIVE_ATTEMPTS\[\$DESC\]:-0\}[\s\S]*?\[ "\$REDERIVE_ATTEMPTS" -ge 2 \] && continue[\s\S]*?EDGE_REDERIVE_ATTEMPTS\[\$DESC\]=\$\(\(REDERIVE_ATTEMPTS \+ 1\)\)/,
    );
    assert.match(
      phase4,
      /case "\$REDERIVE_PROV" in[\s\S]*?contract-deliverables\|affected-files-section\) EDGE_REDERIVED\[\$DESC\]=1 ;;/,
    );
    assert.doesNotMatch(
      phase4,
      /\[ -n "\$\{EDGE_REDERIVED\[\$DESC\]:-\}" \] && continue\s*EDGE_REDERIVED\[\$DESC\]=1/,
    );
  });

  it("limits cohort re-derivation to current descendants and rescans released issues", () => {
    assert.match(
      phase4,
      /STILL_BLOCKED_DESCENDANTS=\(\)[\s\S]*?for CANDIDATE in \{all_blocked_issue_numbers\}; do[\s\S]*?PREDECESSORS\[\$CANDIDATE\][\s\S]*?for DESC in "\$\{STILL_BLOCKED_DESCENDANTS\[@\]\}"; do/,
    );
    assert.match(
      phase4,
      /READINESS_RESCAN=true[\s\S]*?while \[ "\$READINESS_RESCAN" = "true" \]; do[\s\S]*?READINESS_RESCAN=false/,
    );
    assert.match(
      phase4,
      /PREDECESSORS\[\$DESC\]=[\s\S]*?READINESS_RESCAN=true/,
    );
  });

  it("does not claim wake reconstruction re-extracts DONE-path edges", () => {
    assert.match(phase3, /does not retain EDGE_KIND\/EDGE_FILES or re-run Layer 1 extraction/);
    assert.match(phase3, /phase-4-execution\.md lines 1208-1268/);
    assert.doesNotMatch(phase3, /wake re-plan re-runs Step 3C Layer 1 extraction/);
  });

  it("re-reads durable claims before dispatch and pairs release comments by holder", () => {
    assert.match(phase4, /read_active_claims\(\)/);
    assert.match(phase4, /gh api --paginate --slurp/);
    assert.match(phase4, /select\(\.created_at > \$claim\.created_at\)/);
    assert.match(phase4, /capture\("\\\\\*\\\\\*Holder/);
    assert.match(phase4, /claim_conflicts_with_live_holder/);
    assert.match(phase4, /before each engine Bash, Agent\(\), or OpenCode task call/);
    assert.match(phase3, /Rebuild the durable file-claim map/);
    assert.match(phase3, /ACTIVE_CLAIM_FILES/);
  });

  it("documents the compact OpenCode preflight", () => {
    const orchestrate = readFileSync(
      new URL("../../commands/orchestrate.md", import.meta.url),
      "utf8",
    );
    assert.match(orchestrate, /orchestrate-preflight\.mjs/);
    assert.match(orchestrate, /do not load the full\s+Phase 3 or Phase 4 prose just\s+to ask that\s+question/i);
  });
});
