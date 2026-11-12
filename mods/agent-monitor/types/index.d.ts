// Il contratto deve essere autonomo (niente import): ProjectSession vive qui e sessions.ts lo importa.
export type SessionState = 'blocked' | 'working' | 'idle' | 'closed'
export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type AgentUsage = TokenCounts & { model?: string; turns: number; firstAt: number; lastAt: number; ctxTokens?: number; ctxModel?: string; ctxAt?: number }
export type UsageMap = Record<string, AgentUsage>
export type AgentSnapshot = { list: { id: string; parentId?: string; status: string; name?: string; description: string; type: string }[]; stale: boolean; at: number }
export type SessionsSnapshot = { list: ProjectSession[]; stale: boolean; at: number }
export type AlertedMap = Record<string, true>
export type Limits = { soft: number; hard: number; margin: number }
export type Zone = 0 | 1 | 2 | 3
export type CtxValue = { percent?: number; tokens?: number; zone?: Zone }
export type ProjectSession = { id: string; name: string; project: string; cwd?: string; state: SessionState; reason?: string; esito?: string; esitoOra?: string; sessionId?: string; context?: CtxValue }
export type MainContext = { tokens?: number; window: number; percent?: number }
export type SessionContext = { tokens?: number; window?: number; percent?: number; zone: Zone | null; at: number }
export type ContextSnapshot = { main?: MainContext; limits: Limits | null; at: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': { usage: Shaped<UsageMap>; alerted: Shaped<AlertedMap>; agents: Shaped<AgentSnapshot>; selected: Shaped<string>; sessions: Shaped<SessionsSnapshot>; context: Shaped<ContextSnapshot> }
  }
}
