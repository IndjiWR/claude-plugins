// Modello puro delle sessioni di progetto: nessuna chiamata al motore.
import type { ProjectSession, SessionState } from '../types'

export type LiveSession = { id: string; name: string; cwd: string; state?: string; status?: string; waitingFor?: string; sessionId?: string }
export type RegistryEntry = { project: string; name: string; id: string; stato: string; ora?: string; esito?: string; esitoOra?: string }
export type { ProjectSession, SessionState }

// Finestra in cui una sessione chiusa resta visibile (24 h)
export const CLOSED_WINDOW_MS = 86_400_000

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// Output di `claude agents --json`: può avere testo prima del primo `[`
export function parseAgents(text: string): LiveSession[] {
  const start = text.indexOf('[')
  if (start < 0) return []
  let data: unknown
  try {
    data = JSON.parse(text.slice(start))
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: LiveSession[] = []
  for (const r of data) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = str(o.id)
    if (o.kind !== 'background' || !id) continue
    out.push({
      id,
      name: str(o.name) ?? id,
      cwd: str(o.cwd) ?? '',
      state: str(o.state),
      status: str(o.status),
      waitingFor: str(o.waitingFor),
      sessionId: str(o.sessionId),
    })
  }
  return out
}

// Registro della coordinatrice (sessioni.json): chiave = progetto
export function parseRegistry(text: string): RegistryEntry[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const out: RegistryEntry[] = []
  for (const [project, v] of Object.entries(data as Record<string, unknown>)) {
    if (project === 'coordinatrice' || !v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const id = str(o.id)
    if (!id) continue
    out.push({
      project,
      name: str(o.nome) ?? project,
      id,
      stato: str(o.stato) ?? '',
      ora: str(o.ora),
      esito: str(o.esito),
      esitoOra: str(o.esito_ora),
    })
  }
  return out
}

const ORDER: Record<SessionState, number> = { blocked: 0, working: 1, idle: 2, closed: 3 }

function liveState(l: LiveSession): SessionState {
  if (l.state === 'blocked' || (!l.state && l.status === 'waiting')) return 'blocked'
  if (l.state === 'working') return 'working'
  return 'idle'
}

// Ora di chiusura: la più recente tra esito_ora e ora, ignorando i NaN
function closedAt(e: RegistryEntry): number | undefined {
  const ts = [e.esitoOra, e.ora].map(s => (s ? Date.parse(s) : NaN)).filter(n => !Number.isNaN(n))
  return ts.length ? Math.max(...ts) : undefined
}

export function mergeSessions(live: readonly LiveSession[], registry: readonly RegistryEntry[], now: number, selfSessionId?: string): ProjectSession[] {
  const byId = new Map(registry.map(e => [e.id, e]))
  const liveIds = new Set(live.map(l => l.id))
  const out: ProjectSession[] = []
  for (const l of live) {
    if (selfSessionId && l.sessionId === selfSessionId) continue
    const e = byId.get(l.id)
    const state = liveState(l)
    out.push({
      id: l.id,
      name: l.name,
      project: e?.project ?? (l.cwd.split('/').filter(Boolean).pop() ?? l.name),
      cwd: l.cwd,
      state,
      reason: state === 'blocked' ? l.waitingFor : undefined,
      esito: e?.esito,
      esitoOra: e?.esitoOra,
    })
  }
  for (const e of registry) {
    if (liveIds.has(e.id)) continue
    const t = closedAt(e)
    if (t === undefined || now - t > CLOSED_WINDOW_MS) continue
    out.push({ id: e.id, name: e.name, project: e.project, state: 'closed', esito: e.esito, esitoOra: e.esitoOra })
  }
  return out.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name))
}

export function isAttachId(id: string): boolean {
  return /^[0-9a-f]{6,}$/.test(id)
}

export function attachCommand(id: string): string {
  return `claude attach ${id}`
}
