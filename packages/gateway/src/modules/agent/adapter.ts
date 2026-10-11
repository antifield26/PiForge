import type {
  AgentMessage,
  AgentSession,
  AgentStreamEvent,
  PermissionDecision,
  PermissionRequest,
} from "@piforge/shared"

export interface ServerInfo {
  version: string
  pid: number
  urls: string[]
  paths?: Record<string, string>
  capabilities?: Record<string, boolean>
}

export interface ProjectInfo {
  id: string
  directory: string
  canonical?: string
}

export interface EventHandlers {
  onEvent?: (event: AgentStreamEvent) => void
  onError?: (err: Error) => void
}

export interface PromptReq {
  content: string
  model?: string
  agent?: string
}

export interface OpenCodeAdapter {
  info(): Promise<ServerInfo>
  listProjects(): Promise<ProjectInfo[]>
  createSession(title?: string): Promise<AgentSession>
  listSessions(): Promise<AgentSession[]>
  getSession(id: string): Promise<AgentSession | null>
  deleteSession(id: string): Promise<void>
  prompt(id: string, req: PromptReq): Promise<void>
  interrupt(id: string): Promise<void>
  listMessages(id: string): Promise<AgentMessage[]>
  listPermissionRequests(id: string): Promise<PermissionRequest[]>
  replyPermission(id: string, reqId: string, decision: PermissionDecision): Promise<void>
  listAgents(): Promise<{ id: string; name: string; description?: string }[]>
  subscribe(handlers: EventHandlers): () => void
}

export type { AgentMessage, AgentSession, AgentStreamEvent, PermissionDecision, PermissionRequest }
