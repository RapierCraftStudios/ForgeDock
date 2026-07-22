#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commandsDir = join(root, "commands");
const output = join(
  root,
  "native",
  "packages",
  "opencode",
  "src",
  "forgedock",
  "workflows.generated.ts",
);

export async function markdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    }),
  );
  return nested.flat();
}

export function parseInstallTier(content) {
  const frontmatter = content
    .replace(/^\uFEFF/, "")
    .match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return "core";
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^\s*install\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[1].replace(/^["']|["']$/g, "");
    return ["core", "extras", "internal"].includes(value) ? value : "core";
  }
  return "core";
}

export function parseWorkflowKind(content, name) {
  const frontmatter = content
    .replace(/^\uFEFF/, "")
    .match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^\s*workflow-kind\s*:\s*(.*?)\s*$/);
      if (!match) continue;
      const value = match[1].replace(/^["']|["']$/g, "");
      if (["entrypoint", "phase", "agent", "capability"].includes(value))
        return value;
    }
  }
  if (name.startsWith("review-pr-agents/")) return "agent";
  if (name.includes("/")) return "phase";
  return "entrypoint";
}

export function workflowCalls(content) {
  return [
    ...content.matchAll(/\bSkill\s*\(\s*(?:skill\s*[:=]\s*)?["']([^"']+)["']/g),
  ]
    .map((match) => match[1])
    .filter((name, index, calls) => calls.indexOf(name) === index)
    .sort();
}

export function workflowPolicy(name, kind) {
  const review = /review|security|quality-gate|validate/.test(name);
  const build = /build|implement|fix-ci|remediate/.test(name);
  const investigate = /investigate|context|audit|diagnose|explain/.test(name);
  const operate = /deploy|cleanup|incident|recover|rollback|resume/.test(name);
  const role =
    kind === "agent" || review
      ? "review"
      : build
        ? "build"
        : investigate
          ? "investigate"
          : operate
            ? "operate"
            : "orchestrate";
  const budget = /architect|design|review-pr|security-audit|orchestrate/.test(
    name,
  )
    ? "high"
    : /cleanup|changelog|explain|status|close/.test(name)
      ? "low"
      : "standard";
  const capabilities = [
    "tools",
    ...(/design|qa-sweep/.test(name) ? ["vision"] : []),
    ...(/analytics|geo-audit|research/.test(name) ? ["web"] : []),
  ];
  return { role, budget, capabilities };
}

export function nativeTemplate(template) {
  return [
    "<forgedock-runtime>",
    "This specification uses cross-runtime pseudocode. In forgedock-cli, every Skill(...) call that names a ForgeDock command MUST be executed with the workflow tool using the same name and args. Do not load ForgeDock commands through the generic skill tool. Agent(...) and Task(...) calls map to the task tool when an isolated specialist session is required. ForgeDock owns phase selection and durable state; models execute only the requested workflow or phase.",
    "</forgedock-runtime>",
    "",
    template,
  ].join("\n");
}

export async function installableWorkflowFiles(
  dir,
  { includeExtras = false } = {},
) {
  const selected = await Promise.all(
    (await markdownFiles(dir)).map(async (path) => ({
      path,
      tier: parseInstallTier(await readFile(path, "utf8")),
    })),
  );
  return selected
    .filter(
      ({ tier }) => tier === "core" || (includeExtras && tier === "extras"),
    )
    .map(({ path }) => path)
    .sort();
}

export async function generate({ includeExtras = false } = {}) {
  const files = await installableWorkflowFiles(commandsDir, { includeExtras });
  const parsed = await Promise.all(
    files.map(async (path) => {
      const template = (await readFile(path, "utf8")).trim();
      const source = relative(commandsDir, path).split(sep).join("/");
      const name = source.replace(/\.md$/, "");
      const heading = template.match(/^#\s+(.+)$/m)?.[1]?.trim();
      const kind = parseWorkflowKind(template, name);
      return {
        name,
        description: heading || `ForgeDock workflow: ${name}`,
        kind,
        install: parseInstallTier(template),
        source,
        calls: workflowCalls(template),
        policy: workflowPolicy(name, kind),
        engine: name === "work-on" ? "issue" : null,
        template: nativeTemplate(template),
      };
    }),
  );
  const names = new Set(parsed.map((workflow) => workflow.name));
  const workflows = parsed.map((workflow) => ({
    ...workflow,
    calls: workflow.calls
      .map((name) => name.replaceAll(":", "/"))
      .filter(
        (name, index, calls) =>
          names.has(name) && calls.indexOf(name) === index,
      ),
  }));

  const source = [
    "// Generated by scripts/generate-native-workflows.mjs. Do not edit.",
    "// commands/**/*.md is the authoritative ForgeDock workflow source.",
    'import type { BuiltInWorkflow } from "./workflow"',
    "",
    `export const workflows = ${JSON.stringify(workflows, null, 2)} as const satisfies readonly BuiltInWorkflow[]`,
    "",
  ].join("\n");

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, source, "utf8");
  process.stdout.write(
    `Generated ${workflows.length} native ForgeDock workflows.\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--extras")) {
    process.stderr.write("Usage: generate-native-workflows.mjs [--extras]\n");
    process.exitCode = 2;
  } else {
    await generate({ includeExtras: args.includes("--extras") });
  }
}
