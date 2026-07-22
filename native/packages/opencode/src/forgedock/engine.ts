import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { runIssue } from "../../../../../bin/engine.mjs"

export interface PhaseInput {
  readonly commandName: string
  readonly args: string[]
}

export interface Input {
  readonly issue: number
  readonly lane?: string
  readonly expectedRepo?: string
  readonly directory: string
  readonly sessionID: string
  readonly runner: (input: PhaseInput) => Promise<{ usage: null }>
  readonly onProgress?: (event: { event: string; phase: string; status?: string; detail?: string }) => void
}

export async function run(input: Input): Promise<{ terminalReason: string; detail?: string }> {
  const execute = promisify(execFile)
  const command = (bin: string) => async (args: string[]) => {
    const result = await execute(bin, args, {
      cwd: input.directory,
      maxBuffer: 100 * 1024 * 1024,
      timeout: 10_000,
    })
    return result.stdout
  }
  const gh = command("gh")
  if (input.expectedRepo) {
    const repo = (await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim()
    if (repo !== input.expectedRepo) {
      throw new Error(`Requested repository ${input.expectedRepo} does not match the active project ${repo}`)
    }
  }
  const lane = input.lane ?? (await configuredLane(input.directory))
  const executeIssue = runIssue as unknown as (input: {
    issue: number
    lane: string
    agentId: string
    dir: string
    commandsDir: string
    io: { gh: (args: string[]) => Promise<string>; git: (args: string[]) => Promise<string> }
    runner: Input["runner"]
    onProgress?: Input["onProgress"]
  }) => Promise<{ terminalReason: string; detail?: string }>
  return executeIssue({
    issue: input.issue,
    lane,
    agentId: `native_${process.pid}_${input.sessionID}`,
    dir: runDirectory(input.directory),
    commandsDir: "",
    io: { gh, git: command("git") },
    runner: input.runner,
    onProgress: input.onProgress,
  })
}

export function invocation(args: string) {
  if (/\s--remediate\b/.test(` ${args}`)) return
  if (/^\s*[\w.-]+:\d+\b/.test(args)) {
    throw new Error("Satellite issue prefixes require a satellite worktree and are not supported by the native engine")
  }
  const issue = args.trim().match(/^#?(\d+)(?:\s|$)/)?.[1]
  if (!issue) return
  const lane = args.match(/(?:^|\s)--lane\s+(\S+)/)?.[1]
  const expectedRepo = args.match(/(?:^|\s)--repo\s+(\S+)/)?.[1]
  return { issue: Number(issue), lane, expectedRepo }
}

export async function configuredLane(directory: string) {
  const content = await readFile(path.join(directory, "forge.yaml"), "utf8").catch(() => "")
  const section = content.match(/(?:^|\n)branches:\s*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)*)/)?.[1] ?? ""
  const lane = section.match(/^\s+staging:\s*["']?([^\s"'#]+)["']?/m)?.[1]
  if (!lane) throw new Error("forge.yaml must define branches.staging before running the durable workflow engine")
  return lane
}

export function runDirectory(directory: string) {
  const resolved = path.resolve(directory)
  const identity = process.platform === "win32" ? resolved.toLowerCase() : resolved
  const project = createHash("sha256").update(identity).digest("hex").slice(0, 16)
  return path.join(Global.Path.data, "engine", "runs", project)
}

export * as WorkflowEngine from "./engine"
