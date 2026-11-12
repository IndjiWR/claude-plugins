import type { AlertedMap, TokenCounts, UsageMap } from '../types'

export type AgentLike = { id: string; parentId?: string; status: string; name?: string; description: string; type: string }
export type Row = {
  id: string
  depth: number
  label: string
  status: string
  model?: string
  tokens: TokenCounts
  durationMs: number
  turns: number
}
export type TurnUsageLike = {
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export const MAIN = 'main'
export const MAIN_LABEL = 'Sessione principale'
export const ACTIVE = new Set(['pending', 'running', 'waiting', 'idle'])

const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function addTurn(usage: UsageMap, agentId: string | undefined, turn: TurnUsageLike | undefined, now: number): UsageMap {
  const id = agentId || MAIN
  const cur = usage[id]
  const base = cur ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, firstAt: now, lastAt: now }
  const next = {
    ...base,
    input: base.input + n(turn?.input_tokens),
    output: base.output + n(turn?.output_tokens),
    cacheRead: base.cacheRead + n(turn?.cache_read_input_tokens),
    cacheWrite: base.cacheWrite + n(turn?.cache_creation_input_tokens),
    turns: base.turns + 1,
    lastAt: now,
  }
  if (turn?.model) next.model = turn.model
  return { ...usage, [id]: next }
}

export function setModel(usage: UsageMap, agentId: string, model: string, now: number): UsageMap {
  const base = usage[agentId] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, firstAt: now, lastAt: now }
  return { ...usage, [agentId]: { ...base, model } }
}

/** Prima volta che si vede un agente: fissa firstAt (e il modello, se noto); non tocca una voce già presente. */
export function seedAgent(usage: UsageMap, agentId: string, now: number, model?: string): UsageMap {
  const cur = usage[agentId]
  if (cur) return model && !cur.model ? { ...usage, [agentId]: { ...cur, model } } : usage
  const base = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, firstAt: now, lastAt: now }
  return { ...usage, [agentId]: model ? { ...base, model } : base }
}

const truncate = (s: string) => (s.length > 40 ? s.slice(0, 40) + '…' : s)

/** Etichetta unica per pannello e avvisi: nome, altrimenti descrizione, altrimenti id; "main" è la sessione principale. */
export function agentLabel(id: string, agents: readonly AgentLike[]): string {
  if (id === MAIN) return MAIN_LABEL
  const a = agents.find((x) => x.id === id)
  return truncate(a ? a.name || a.description : id)
}

export function buildTree(agents: readonly AgentLike[], usage: UsageMap, now: number): Row[] {
  const list = agents.filter((a) => a.id !== MAIN)
  const known = new Set(list.map((a) => a.id))
  const orphans = Object.keys(usage).filter((id) => id !== MAIN && !known.has(id))
  const nodes = new Map<string, { id: string; parentId?: string; status: string; label: string }>()
  for (const a of list) nodes.set(a.id, { id: a.id, parentId: a.parentId, status: a.status, label: agentLabel(a.id, agents) })
  for (const id of orphans) nodes.set(id, { id, status: 'completed', label: agentLabel(id, agents) })

  const first = (id: string) => usage[id]?.firstAt ?? now
  const children = new Map<string, string[]>()
  for (const nd of nodes.values()) {
    const p = nd.parentId && nd.parentId !== nd.id && nodes.has(nd.parentId) ? nd.parentId : MAIN
    children.set(p, [...(children.get(p) ?? []), nd.id])
  }
  const rowOf = (id: string, depth: number, label: string, status: string): Row => {
    const u = usage[id]
    const firstAt = u?.firstAt ?? now
    return {
      id,
      depth,
      label,
      status,
      model: u?.model,
      tokens: { input: u?.input ?? 0, output: u?.output ?? 0, cacheRead: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0 },
      durationMs: ACTIVE.has(status) ? now - firstAt : (u?.lastAt ?? firstAt) - firstAt,
      turns: u?.turns ?? 0,
    }
  }

  const rows: Row[] = [rowOf(MAIN, 0, MAIN_LABEL, 'running')]
  const seen = new Set<string>([MAIN])
  const walk = (parent: string, depth: number) => {
    const kids = [...(children.get(parent) ?? [])].sort((a, b) => first(a) - first(b))
    for (const id of kids) {
      if (seen.has(id)) continue
      seen.add(id)
      const nd = nodes.get(id)!
      rows.push(rowOf(id, depth, nd.label, nd.status))
      walk(id, depth + 1)
    }
  }
  walk(MAIN, 1)
  return rows
}

export function totals(usage: UsageMap): TokenCounts & { turns: number } {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }
  for (const u of Object.values(usage)) {
    t.input += u.input
    t.output += u.output
    t.cacheRead += u.cacheRead
    t.cacheWrite += u.cacheWrite
    t.turns += u.turns
  }
  return t
}

export function overThreshold(usage: UsageMap, alerted: AlertedMap, limit: number): string[] {
  if (!(limit > 0)) return []
  return Object.keys(usage).filter((id) => {
    if (id === MAIN || alerted[id]) return false
    const u = usage[id]
    return u.input + u.output >= limit
  })
}

const dec = (v: number) => v.toFixed(1).replace('.', ',')

export function formatTokens(v: number): string {
  if (v < 1000) return String(Math.round(v))
  const k = Math.round((v / 1000) * 10) / 10
  if (k < 1000) return dec(k) + 'k'
  return dec(v / 1e6) + 'M'
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const p2 = (x: number) => String(x).padStart(2, '0')
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${p2(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${p2(Math.floor((s % 3600) / 60))}m`
}

export type StatusCounts = { active: number; waiting: number; pending: number; done: number; failed: number }

export function countByStatus(rows: Row[]): StatusCounts {
  const c: StatusCounts = { active: 0, waiting: 0, pending: 0, done: 0, failed: 0 }
  for (const r of rows) {
    if (r.id === MAIN) continue
    if (r.status === 'running' || r.status === 'idle') c.active++
    else if (r.status === 'waiting') c.waiting++
    else if (r.status === 'pending') c.pending++
    else if (r.status === 'completed') c.done++
    else if (r.status === 'failed' || r.status === 'killed') c.failed++
  }
  return c
}

export function shortModel(model: string | undefined): string {
  if (!model) return '?'
  for (const k of ['haiku', 'sonnet', 'opus']) if (model.includes(k)) return k
  return model
}

export function tokensByModel(usage: UsageMap): Array<{ model: string; tokens: number }> {
  const by = new Map<string, number>()
  for (const u of Object.values(usage)) {
    const k = shortModel(u.model)
    by.set(k, (by.get(k) ?? 0) + u.input + u.output)
  }
  return [...by].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens)
}

const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** Formato compatto per il pannello: 950, 1,5k, 2k, 280k, 1,2M, 12M. */
export function formatCompact(v: number): string {
  const unit = (x: number, suffix: string) => {
    if (x >= 10) return `${Math.round(x)}${suffix}`
    const r = Math.round(x * 10) / 10
    return Number.isInteger(r) ? `${r}${suffix}` : `${dec(r)}${suffix}`
  }
  if (v < 1000) return String(Math.round(v))
  if (v < 1e6) {
    const k = v / 1000
    // 9,96k arrotonda a 10k: passa dal ramo "intero".
    return k < 9.95 ? unit(k, 'k') : `${Math.round(k) >= 1000 ? '1M' : Math.round(k) + 'k'}`
  }
  const m = v / 1e6
  return m < 9.95 ? unit(m, 'M') : `${Math.round(m)}M`
}

export function bar(value: number, max: number, width: number): string {
  const w = Math.max(0, Math.floor(width))
  if (!(max > 0) || !(value > 0)) return ' '.repeat(w)
  const cells = Math.min(1, value / max) * w
  const full = Math.floor(cells)
  const idx = Math.floor((cells - full) * 8)
  const part = full < w ? PARTIAL[full === 0 && idx === 0 ? 1 : idx] : ''
  return ('█'.repeat(full) + part).padEnd(w, ' ')
}

export function usageLevel(tokens: number, limit: number): 'ok' | 'warn' | 'over' {
  if (!(limit > 0)) return 'ok'
  if (tokens >= limit) return 'over'
  return tokens >= limit * 0.7 ? 'warn' : 'ok'
}
