import { atom, read, update } from 'claude-code'
import type { Register, StateDollar, Timer } from 'claude-code'

import type { AgentSnapshot, AlertedMap, TokenCounts, UsageMap } from '../types'
import { ACTIVE, MAIN, addTurn, agentLabel, buildTree, formatDuration, formatTokens, overThreshold, seedAgent, setModel, totals } from './ledger'
import type { AgentLike, Row } from './ledger'

// Cambia il tag se cambia la forma del valore: un reload con un altro tag lo legge come assente.
const usageAtom = atom({ plugin: 'agent-monitor', key: 'usage' } as const, {} as UsageMap, { shape: 'usage-1' })
const alertedAtom = atom({ plugin: 'agent-monitor', key: 'alerted' } as const, {} as AlertedMap, { shape: 'alerted-1' })
const agentsAtom = atom({ plugin: 'agent-monitor', key: 'agents' } as const, { list: [], stale: false, at: 0 } as AgentSnapshot, { shape: 'agents-1' })
const PANE = 'agenti'

const counts = (t: TokenCounts) =>
  `in ${formatTokens(t.input)} / out ${formatTokens(t.output)} / cache ${formatTokens(t.cacheRead)}+${formatTokens(t.cacheWrite)}`

const rowLine = (r: Row) =>
  `${'  '.repeat(r.depth)}${r.status} ${r.label} · ${r.model ?? '—'} · ${counts(r.tokens)} · ${formatDuration(r.durationMs)} · ${r.turns} turni`
const totalLine = (tot: TokenCounts & { turns: number }) => `Totale: ${counts(tot)} · ${tot.turns} turni`

export function textSummary(rows: Row[], tot: TokenCounts & { turns: number }): string {
  const lines = rows.map(rowLine)
  lines.push(totalLine(tot))
  return lines.join('\n')
}

type Ctx = StateDollar & {
  agent: { list: () => Promise<readonly AgentLike[]> }
  clock: { now: () => Promise<number>; every: (ms: number, fn: () => void) => Timer }
}
let timer: Timer | undefined
let lastRender = 0

// Rilegge l'elenco; se rifiuta tiene l'ultimo e segna "non aggiornato".
async function refresh($: Ctx) {
  try {
    const list = await $.agent.list()
    const at = await $.clock.now()
    const ids = list.map((a) => a.id).filter((id) => id !== MAIN)
    if (ids.length > 0) await update($, usageAtom, (u) => ids.reduce((acc, id) => seedAgent(acc, id, at), u))
    await update($, agentsAtom, () => ({
      list: list.map((a) => ({ id: a.id, parentId: a.parentId, status: a.status, name: a.name, description: a.description, type: a.type })),
      stale: false,
      at,
    }))
  } catch {
    // `at` cambia a ogni giro: il valore nuovo fa ridisegnare il pannello aperto, così il timer non si ferma.
    const at = await $.clock.now().catch(() => 0)
    await update($, agentsAtom, (s) => ({ ...s, stale: true, at: at || s.at || -1 }))
  }
}

function stopTimer() {
  timer?.cancel()
  timer = undefined
}

function startTimer($: Ctx, refreshMs: number) {
  if (timer) return
  timer = $.clock.every(refreshMs, async () => {
    try {
      await refresh($)
      // Rete di sicurezza: se il pannello non viene più disegnato per 3 intervalli il timer si ferma.
      if ((await $.clock.now()) - lastRender > refreshMs * 3) stopTimer()
    } catch {
      // mai una rejection non gestita; il prossimo giro riprova
    }
  })
}

export const register: Register = (on, options) => {
  const opts = options as Record<string, unknown> | undefined
  const limit = Number(opts?.alertTokens ?? 200000)
  const refreshMs = Math.max(500, Number(opts?.refreshMs ?? 2000) || 2000)
  on('session.start', async ($, e, next) => {
    stopTimer()
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
    let fresh: string[] = []
    await update($, alertedAtom, (m) => {
      fresh = overThreshold(usage, m, limit)
      return fresh.length > 0 ? { ...m, ...Object.fromEntries(fresh.map((id) => [id, true as const])) } : m
    })
    if (fresh.length > 0) {
      const list = await $.agent.list().catch(() => [] as readonly AgentLike[])
      for (const id of fresh) $.ui.toast(`Agente ${agentLabel(id, list)} oltre ${formatTokens(limit)} token`)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const id = r.agentId
      const model = e.model
      const now = await $.clock.now()
      await update($, usageAtom, (u) => (model ? setModel(u, id, model, now) : seedAgent(u, id, now)))
    }
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'agenti' }, async ($, e) => {
    if (e.args.trim() === 'chat') {
      await $.ui.view({})
      return {}
    }
    const opened = await $.ui.open({ id: PANE, title: 'Agenti', focus: true })
    if (opened.isPlaced) {
      lastRender = await $.clock.now()
      await refresh($)
      startTimer($, refreshMs)
      return {}
    }
    const now = await $.clock.now()
    const usage = await read($, usageAtom)
    let agents: readonly AgentLike[]
    let stale = false
    try {
      agents = await $.agent.list()
    } catch {
      agents = (await read($, agentsAtom)).list
      stale = true
    }
    return {
      text:
        `Il pannello non si apre qui (${opened.reason}).\n` +
        textSummary(buildTree(agents, usage, now), totals(usage)) +
        (stale ? '\nelenco non aggiornato' : ''),
    }
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) stopTimer()
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    lastRender = now
    if ((await read($, agentsAtom)).at === 0) await refresh($)
    startTimer($, refreshMs)
    const snap = await read($, agentsAtom)
    const usage = await read($, usageAtom)
    const rows = buildTree(snap.list, usage, now)
    const status = new Map(snap.list.map((a) => [a.id, a.status]))
    return (
      <Box flexDirection="column">
        {rows.map((r) => (
          <Box key={`row-${r.id}`} flexDirection="row">
            <Text>{rowLine(r)}</Text>
            {r.id !== MAIN && (
              <Button
                key={`transcript-${r.id}`}
                label="Transcript"
                onPress={() => {
                  void $.ui.view({ agentId: r.id })
                }}
              />
            )}
            {r.id !== MAIN && ACTIVE.has(status.get(r.id) ?? r.status) && (
              <Button
                key={`stop-${r.id}`}
                label="Ferma"
                onPress={async () => {
                  let answer: string
                  try {
                    answer = await $.ui.ask(`Fermo l'agente ${r.label}?`, ['Ferma', 'Annulla'])
                  } catch {
                    return // conferma chiusa senza risposta: come "Annulla"
                  }
                  if (answer !== 'Ferma') return
                  try {
                    await $.tool.call({ tool: 'TaskStop', task_id: r.id })
                    $.ui.toast(`Agente ${r.label} fermato`)
                  } catch (err) {
                    $.ui.toast(`Impossibile fermare ${r.label}: ${err instanceof Error ? err.message : String(err)}`)
                  }
                }}
              />
            )}
          </Box>
        ))}
        <Text>{totalLine(totals(usage))}</Text>
        {snap.stale && <Text dimColor>elenco non aggiornato</Text>}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
