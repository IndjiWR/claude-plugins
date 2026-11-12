export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type AgentUsage = TokenCounts & { model?: string; turns: number; firstAt: number; lastAt: number }
export type UsageMap = Record<string, AgentUsage>
export type AgentSnapshot = { list: { id: string; parentId?: string; status: string; name?: string; description: string; type: string }[]; stale: boolean; at: number }
export type AlertedMap = Record<string, true>

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': { usage: Shaped<UsageMap>; alerted: Shaped<AlertedMap>; agents: Shaped<AgentSnapshot> }
  }
}
