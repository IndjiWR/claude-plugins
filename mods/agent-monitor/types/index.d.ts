// Il contratto deve essere autonomo (niente import): ProjectSession vive qui e sessions.ts lo importa.
export type SessionState = 'blocked' | 'working' | 'idle' | 'closed'
export type ProjectSession = { id: string; name: string; project: string; cwd?: string; state: SessionState; reason?: string; esito?: string; esitoOra?: string }
export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type AgentUsage = TokenCounts & { model?: string; turns: number; firstAt: number; lastAt: number }
export type UsageMap = Record<string, AgentUsage>
export type AgentSnapshot = { list: { id: string; parentId?: string; status: string; name?: string; description: string; type: string }[]; stale: boolean; at: number }
export type SessionsSnapshot = { list: ProjectSession[]; stale: boolean; at: number }
export type AlertedMap = Record<string, true>

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': { usage: Shaped<UsageMap>; alerted: Shaped<AlertedMap>; agents: Shaped<AgentSnapshot>; selected: Shaped<string>; sessions: Shaped<SessionsSnapshot> }
  }
}
