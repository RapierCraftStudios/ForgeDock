import type { SessionID } from "@/session/schema"

const sessions = new Set<SessionID>()

export function mark(sessionID: SessionID) {
  sessions.add(sessionID)
}

export function has(sessionID: SessionID) {
  return sessions.has(sessionID)
}

export * as WorkflowSession from "./session"
