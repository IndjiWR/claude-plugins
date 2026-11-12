import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AlertedMap, TokenCounts, UsageMap } from '../types'
import { addTurn, buildTree, formatDuration, formatTokens, overThreshold, setModel, totals } from './ledger'
import type { Row } from './ledger'

// Cambia il tag se cambia la forma del valore: un reload con un altro tag lo legge come assente.
const usageAtom = atom({ plugin: 'agent-monitor', key: 'usage' } as const, {} as UsageMap, { shape: 'usage-1' })
const alertedAtom = atom({ plugin: 'agent-monitor', key: 'alerted' } as const, {} as AlertedMap, { shape: 'alerted-1' })

const counts = (t: TokenCounts) =>
  `in ${formatTokens(t.input)} / out ${formatTokens(t.output)} / cache ${formatTokens(t.cacheRead)}+${formatTokens(t.cacheWrite)}`

export function textSummary(rows: Row[], tot: TokenCounts & { turns: number }): string {
  const lines = rows.map(
    (r) =>
      `${'  '.repeat(r.depth)}${r.status} ${r.label} · ${r.model ?? '—'} · ${counts(r.tokens)} · ${formatDuration(r.durationMs)} · ${r.turns} turni`,
  )
  lines.push(`Totale: ${counts(tot)} · ${tot.turns} turni`)
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const limit = Number((options as Record<string, unknown> | undefined)?.alertTokens ?? 200000)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agenti',
      description: 'Pannello live degli agenti: stato e consumi',
      argumentHint: '[chat]',
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    const usage = await update($, usageAtom, (u) => addTurn(u, e.agentId, e.usage, now))
    const alerted = await read($, alertedAtom)
    const over = overThreshold(usage, alerted, limit)
    if (over.length > 0) {
      const list = await $.agent.list()
      for (const id of over) {
        const a = list.find((x) => x.id === id)
        $.ui.toast(`Agente ${a?.name ?? a?.description ?? id} oltre ${formatTokens(limit)} token`)
      }
      await update($, alertedAtom, (m) => ({ ...m, ...Object.fromEntries(over.map((id) => [id, true as const])) }))
    }
    return r
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (e.model && r.agentId) {
      const id = r.agentId
      const model = e.model
      const now = await $.clock.now()
      await update($, usageAtom, (u) => setModel(u, id, model, now))
    }
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'agenti' }, async ($, e) => {
    if (e.args.trim() === 'chat') {
      await $.ui.view({})
      return {}
    }
    const now = await $.clock.now()
    const usage = await read($, usageAtom)
    const agents = await $.agent.list()
    return { text: textSummary(buildTree(agents, usage, now), totals(usage)) }
  }).catch(($, e, next) => next(e))
}
