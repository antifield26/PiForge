export interface AgentSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface AgentMessage {
  id: string
  sessionId: string
  role: "user" | "assistant" | "system"
  content: string
  createdAt: number
}

export interface PermissionRequest {
  id: string
  sessionId: string
  tool: string
  description: string
  createdAt: number
}

export type PermissionDecision = "allow" | "deny" | "always"

export type AgentStreamEvent =
  | { type: "session.update"; sessionId: string; title?: string }
  | { type: "message.update"; sessionId: string; messageId: string; content: string; done: boolean }
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "error"; message: string }
