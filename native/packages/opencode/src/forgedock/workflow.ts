import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { workflows } from "./workflows.generated"

export type Kind = "entrypoint" | "phase" | "agent" | "capability"
export type InstallTier = "core" | "extras" | "internal"
export type Role = "orchestrate" | "investigate" | "build" | "review" | "operate"
export type Budget = "low" | "standard" | "high"
export type Capability = "tools" | "vision" | "web"

export interface BuiltInWorkflow {
  readonly name: string
  readonly description: string
  readonly kind: Kind
  readonly install: InstallTier
  readonly source: string
  readonly calls: readonly string[]
  readonly policy: {
    readonly role: Role
    readonly budget: Budget
    readonly capabilities: readonly Capability[]
  }
  readonly engine: "issue" | null
  readonly template: string
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<BuiltInWorkflow | undefined>
  readonly list: () => Effect.Effect<readonly BuiltInWorkflow[]>
}

export function normalizeName(name: string) {
  return name.replaceAll(":", "/")
}

export function commandTemplate(workflow: BuiltInWorkflow) {
  if (!workflow.engine) return workflow.template
  return [
    "<forgedock-runtime>",
    `Immediately invoke the workflow tool with name=${JSON.stringify(workflow.name)} and arguments exactly equal to: $ARGUMENTS`,
    "Do not execute the workflow inline. The workflow tool hands this entrypoint to ForgeDock's durable engine, which owns phase selection, leases, retries, and recovery.",
    "</forgedock-runtime>",
  ].join("\n")
}

export class Service extends Context.Service<Service, Interface>()("@forgedock/Workflow") {}

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const catalog = new Map<string, BuiltInWorkflow>()
    for (const workflow of workflows) {
      if (catalog.has(workflow.name)) throw new Error(`Duplicate ForgeDock workflow: ${workflow.name}`)
      catalog.set(workflow.name, workflow)
    }
    return Service.of({
      get: (name) => Effect.succeed(catalog.get(normalizeName(name))),
      list: () => Effect.succeed(workflows),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as Workflow from "./workflow"
