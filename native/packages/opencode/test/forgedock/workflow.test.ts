import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Exit } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { WorkflowTool } from "@/tool/workflow"
import { Workflow } from "@/forgedock/workflow"
import { WorkflowEngine } from "@/forgedock/engine"
import { Provider } from "@/provider/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
    Workflow.node,
    Provider.node,
  ]),
)

const it = testEffect(layer)

const seed = Effect.fn("WorkflowToolTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Parent" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "build",
      agent: input.agent ?? "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text: "done",
      },
    ],
  }
}

function ops(onPrompt?: (input: SessionPrompt.PromptInput) => void): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        onPrompt?.(input)
        return reply(input)
      }),
  }
}

describe("forgedock workflow", () => {
  it.effect("exposes a typed built-in catalog and call graph", () =>
    Effect.gen(function* () {
      const registry = yield* Workflow.Service
      expect((yield* registry.list()).length).toBeGreaterThan(0)
      expect((yield* registry.list()).some((item) => item.install === "internal")).toBe(false)
      const workflow = yield* registry.get("work-on")
      expect(workflow?.kind).toBe("entrypoint")
      expect(workflow?.engine).toBe("issue")
      expect(workflow?.calls).toContain("work-on/investigate")
      expect(Workflow.commandTemplate(workflow!)).toContain("Immediately invoke the workflow tool")
      expect((yield* registry.get("work-on/build"))?.kind).toBe("phase")
      expect((yield* registry.get("work-on:build:context"))?.name).toBe("work-on/build/context")
      expect(Workflow.commandTemplate((yield* registry.get("work-on/build"))!)).toContain("# work-on/build")
      expect((yield* registry.get("review-pr-agents/security"))?.kind).toBe("agent")
      const names = new Set((yield* registry.list()).map((item) => item.name))
      expect((yield* registry.list()).flatMap((item) => item.calls).every((name) => names.has(name))).toBe(true)
    }),
  )

  it.effect("routes only standard issue invocations to the durable engine", () =>
    Effect.sync(() => {
      expect(WorkflowEngine.invocation("#42 --lane main")).toEqual({
        issue: 42,
        lane: "main",
        expectedRepo: undefined,
      })
      expect(WorkflowEngine.invocation("42 --repo acme/app")).toEqual({
        issue: 42,
        lane: undefined,
        expectedRepo: "acme/app",
      })
      expect(WorkflowEngine.invocation("42 --remediate")).toBeUndefined()
      expect(() => WorkflowEngine.invocation("app:42")).toThrow("Satellite issue prefixes")
    }),
  )

  it.instance("resolves the configured lane and isolates run logs by project", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(`${test.directory}/forge.yaml`, "branches:\n  staging: develop\n"))
      expect(yield* Effect.promise(() => WorkflowEngine.configuredLane(test.directory))).toBe("develop")
      expect(WorkflowEngine.runDirectory(test.directory)).not.toBe(
        WorkflowEngine.runDirectory(`${test.directory}-other`),
      )
    }),
  )

  it.instance("runs an authorized built-in workflow in a marked child session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* WorkflowTool
      const def = yield* tool.init()
      const requests: string[] = []
      let prompt: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        { name: "work-on/investigate", arguments: "42 --repo app" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: ops((input) => (prompt = input)) },
          messages: [],
          metadata: () => Effect.void,
          ask: (request) => Effect.sync(() => requests.push(`${request.permission}:${request.patterns[0]}`)),
        },
      )

      expect(requests).toEqual(["workflow:work-on/investigate"])
      expect(result.metadata.workflow).toBe("work-on/investigate")
      const child = yield* sessions.get(result.metadata.sessionId)
      expect(child.parentID).toBe(chat.id)
      expect(child.metadata?.["forgedock.workflow"]).toBe("work-on/investigate")
      expect(child.permission?.some((rule) => rule.permission === "task" && rule.action === "deny")).toBe(false)
      expect(child.permission?.some((rule) => rule.permission === "todowrite" && rule.action === "deny")).toBe(false)
      expect(prompt?.parts.find((part) => part.type === "text")?.text).toContain("42 --repo app")
    }),
  )

  it.instance("does not charge workflow wrappers against subagent depth", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const workflow = yield* WorkflowTool
      const workflowDef = yield* workflow.init()
      const result = yield* workflowDef.execute(
        { name: "work-on/investigate", arguments: "42" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: ops() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const childAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        sessionID: result.metadata.sessionId,
      })
      const task = yield* TaskTool
      const taskDef = yield* task.init()
      const nested = yield* taskDef.execute(
        { description: "inspect issue", prompt: "inspect", subagent_type: "general" },
        {
          sessionID: result.metadata.sessionId,
          messageID: childAssistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: ops() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect((yield* sessions.get(nested.metadata.sessionId)).parentID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("does not trust forge-looking metadata to bypass subagent depth", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Untrusted",
        metadata: { "forgedock.workflow": "work-on" },
      })
      const childAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        sessionID: child.id,
      })
      const task = yield* TaskTool
      const taskDef = yield* task.init()
      const exit = yield* taskDef
        .execute(
          { description: "inspect issue", prompt: "inspect", subagent_type: "general" },
          {
            sessionID: child.id,
            messageID: childAssistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: ops() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
