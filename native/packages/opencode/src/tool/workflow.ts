import { Effect, Option, Schema } from "effect"
import { Workflow } from "@/forgedock/workflow"
import { Agent } from "@/agent/agent"
import { WorkflowEngine } from "@/forgedock/engine"
import { EffectBridge } from "@/effect/bridge"
import type { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { Database } from "@opencode-ai/core/database/database"
import { TaskTool, type TaskPromptOps } from "./task"
import { Tool } from "./tool"
import DESCRIPTION from "./workflow.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The built-in ForgeDock workflow name" }),
  arguments: Schema.optional(Schema.String).annotate({ description: "Arguments passed to the workflow" }),
})

interface WorkflowMetadata {
  [key: string]: unknown
  workflow: string
  kind: Workflow.Kind
  source: string
  policy: Workflow.BuiltInWorkflow["policy"]
  engine: "issue" | null
  terminalReason: string | null
  sessionIds: SessionID[]
  sessionId: SessionID
}

export const WorkflowTool = Tool.define(
  "workflow",
  Effect.gen(function* () {
    const registry = yield* Workflow.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const database = yield* Database.Service
    const task = yield* TaskTool
    const taskDef = yield* task.init()
    const catalog = (yield* registry.list())
      .filter((workflow) => workflow.install !== "internal")
      .map((workflow) => `- ${workflow.name} (${workflow.kind}): ${workflow.description}`)
      .join("\n")

    return {
      description: [DESCRIPTION, "", "Available ForgeDock workflows:", catalog].join("\n"),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const workflow = yield* registry.get(params.name)
          if (!workflow) {
            const available = (yield* registry.list()).map((item) => item.name).join(", ")
            return yield* Effect.fail(
              new Error(`Unknown ForgeDock workflow: ${params.name}. Available workflows: ${available}`),
            )
          }
          if (workflow.install === "internal") {
            return yield* Effect.fail(
              new Error(`ForgeDock workflow is internal and cannot be invoked: ${workflow.name}`),
            )
          }

          yield* ctx.ask({
            permission: "workflow",
            patterns: [workflow.name],
            always: [workflow.name],
            metadata: { kind: workflow.kind, source: workflow.source },
          })

          const sessions: SessionID[] = []
          const execute = Effect.fnUntraced(function* (item: Workflow.BuiltInWorkflow, args: string) {
            const roleAgent = yield* agents.get(`forgedock-${item.policy.role}`)
            const selectedAgent = roleAgent ?? (yield* agents.get(ctx.agent))
            const message = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.orDie,
            )
            if (message.info.role !== "assistant")
              return yield* Effect.fail(new Error("Workflow requires an assistant message"))
            const ref = selectedAgent?.model ?? {
              providerID: message.info.providerID,
              modelID: message.info.modelID,
            }
            const model = yield* provider.getModel(ref.providerID, ref.modelID).pipe(Effect.option)
            if (
              Option.isSome(model) &&
              item.policy.capabilities.includes("tools") &&
              !model.value.capabilities.toolcall
            ) {
              return yield* Effect.fail(new Error(`Workflow ${item.name} requires a model with tool-call support`))
            }
            if (
              Option.isSome(model) &&
              item.policy.capabilities.includes("vision") &&
              !model.value.capabilities.input.image
            ) {
              return yield* Effect.fail(new Error(`Workflow ${item.name} requires a vision-capable model`))
            }
            const result = yield* taskDef.execute(
              {
                description: item.description,
                prompt: render(item.template, args),
                subagent_type: selectedAgent?.name ?? ctx.agent,
              },
              {
                ...ctx,
                extra: {
                  allowOrchestration: true,
                  bypassAgentCheck: true,
                  childSessionMetadata: {
                    "forgedock.workflow": item.name,
                    "forgedock.workflow.kind": item.kind,
                    "forgedock.workflow.role": item.policy.role,
                  },
                  promptOps: ctx.extra?.promptOps as TaskPromptOps | undefined,
                  workflowSession: true,
                },
              },
            )
            sessions.push(result.metadata.sessionId)
            return result
          })

          const args = params.arguments ?? ""
          const durable = workflow.engine === "issue" ? WorkflowEngine.invocation(args) : undefined
          if (workflow.engine && !durable && !/\s--remediate\b/.test(` ${args}`)) {
            return yield* Effect.fail(
              new Error(`Unsupported durable ${workflow.name} invocation: ${args || "<empty>"}`),
            )
          }
          if (durable) {
            const bridge = yield* EffectBridge.make()
            const instance = yield* InstanceState.context
            const progress: string[] = []
            const result = yield* Effect.promise(() =>
              WorkflowEngine.run({
                ...durable,
                directory: instance.worktree,
                sessionID: ctx.sessionID,
                runner: async (input) => {
                  const phase = await bridge.promise(registry.get(input.commandName))
                  if (!phase) throw new Error(`Engine selected unknown ForgeDock phase: ${input.commandName}`)
                  await bridge.promise(execute(phase, input.args.join(" ")))
                  return { usage: null }
                },
                onProgress: (event) =>
                  progress.push([event.event, event.phase, event.status, event.detail].filter(Boolean).join(":")),
              }),
            )
            const metadata: WorkflowMetadata = {
              workflow: workflow.name,
              kind: workflow.kind,
              source: workflow.source,
              policy: workflow.policy,
              engine: "issue",
              terminalReason: result.terminalReason,
              sessionIds: sessions,
              sessionId: sessions.at(-1) ?? ctx.sessionID,
            }
            return {
              title: `Workflow: ${workflow.name}`,
              output: [
                `ForgeDock engine completed with terminal reason: ${result.terminalReason}`,
                ...(result.detail ? [result.detail] : []),
                ...progress,
              ].join("\n"),
              metadata,
            }
          }

          const result = yield* execute(workflow, args)
          const metadata: WorkflowMetadata = {
            ...result.metadata,
            workflow: workflow.name,
            kind: workflow.kind,
            source: workflow.source,
            policy: workflow.policy,
            engine: null,
            terminalReason: null,
            sessionIds: sessions,
            sessionId: result.metadata.sessionId,
          }

          return {
            ...result,
            title: `Workflow: ${workflow.name}`,
            metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function render(template: string, args: string) {
  const values = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((value) => value.replace(/^["']|["']$/g, "")) ?? []
  const placeholders = template.match(/\$\d+/g) ?? []
  const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
  const output = template.replaceAll(/\$(\d+)/g, (_, index) => {
    const position = Number(index)
    if (position > values.length) return ""
    if (position === last) return values.slice(position - 1).join(" ")
    return values[position - 1]
  })
  const usesArguments = template.includes("$ARGUMENTS")
  const rendered = output.replaceAll("$ARGUMENTS", args)
  if (placeholders.length || usesArguments || !args.trim()) return rendered.trim()
  return `${rendered}\n\n${args}`.trim()
}
