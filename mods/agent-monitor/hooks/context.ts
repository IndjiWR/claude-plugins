// Modello puro del contesto usato e delle zone: nessuna chiamata al motore.
import type { AgentUsage, CtxValue, Limits, MainContext, SessionContext, Zone } from '../types'
import { formatCompact } from './ledger'

export type { CtxValue, Limits, MainContext, SessionContext, Zone }

export const ZONE_SHORT: readonly string[] = ['nor', 'mor', 'dur', 'mar']
export const ZONE_LONG: readonly string[] = ['zona normale', 'zona morbida', 'zona dura', 'margine di sicurezza superato']

const num = (rows: readonly { key: string; value: unknown }[], key: string): number | undefined => {
  const v = rows.find(r => r.key === key)?.value
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// Stesse regole di auto-clear-context; soglia morbida <= 0 = monitor spento
export function limitsFrom(rows: readonly { key: string; value: unknown }[]): Limits | undefined {
  const soft = num(rows, 'auto-clear-context.threshold')
  const h = num(rows, 'auto-clear-context.hardThreshold')
  if (soft === undefined || h === undefined || soft <= 0) return undefined
  const hard = Math.min(95, Math.max(h, soft + 10))
  return { soft, hard, margin: Math.min(95, hard + 15) }
}

export function zoneOf(percent: number, limits: Limits): Zone {
  if (percent >= limits.margin) return 3
  if (percent >= limits.hard) return 2
  if (percent >= limits.soft) return 1
  return 0
}

export function contextTokens(u: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

export function mainValue(main: MainContext | undefined, limits: Limits | undefined): CtxValue {
  if (!main || main.percent === undefined) return {}
  const v: CtxValue = { percent: main.percent }
  if (main.tokens !== undefined) v.tokens = main.tokens
  if (limits) v.zone = zoneOf(main.percent, limits)
  return v
}

// La percentuale vale solo se il modello dell'agente è quello della sessione principale
export function agentValue(u: AgentUsage | undefined, mainWindow: number | undefined, mainModel: string | undefined, limits: Limits | undefined): CtxValue {
  if (!u || u.ctxTokens === undefined) return {}
  if (!mainWindow || mainWindow <= 0 || u.ctxModel === undefined || u.ctxModel !== mainModel) return { tokens: u.ctxTokens }
  const percent = Math.round((u.ctxTokens / mainWindow) * 100)
  const v: CtxValue = { percent, tokens: u.ctxTokens }
  if (limits) v.zone = zoneOf(percent, limits)
  return v
}

export function ctxCell(v: CtxValue): string {
  if (v.percent !== undefined) return v.zone !== undefined ? `${v.percent}% ${ZONE_SHORT[v.zone]}` : `${v.percent}%`
  if (v.tokens !== undefined) return formatCompact(v.tokens)
  return '—'
}

export function ctxText(v: CtxValue): string {
  if (v.percent !== undefined) return v.zone !== undefined ? `ctx ${v.percent}% (${ZONE_LONG[v.zone]})` : `ctx ${v.percent}%`
  if (v.tokens !== undefined) return `ctx ${formatCompact(v.tokens)}`
  return ''
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function parseContextFile(text: string): SessionContext | undefined {
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined
  const o = d as Record<string, unknown>
  if (!isNum(o.at)) return undefined
  let zone: Zone | null = null
  if (o.zone !== undefined && o.zone !== null) {
    if (o.zone !== 0 && o.zone !== 1 && o.zone !== 2 && o.zone !== 3) return undefined
    zone = o.zone
  }
  const r: SessionContext = { zone, at: o.at }
  if (isNum(o.tokens)) r.tokens = o.tokens
  if (isNum(o.window)) r.window = o.window
  if (isNum(o.percent)) r.percent = o.percent
  return r
}

export function contextFilePath(home: string, sessionId: string): string {
  return `${home}/.claude/agent-monitor/contesto/${sessionId}.json`
}
