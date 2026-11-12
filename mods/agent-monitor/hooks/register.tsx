import { atom, read, update } from 'claude-code'
import type { Register, StateDollar, Timer } from 'claude-code'

import type { AgentSnapshot, AlertedMap, TokenCounts, UsageMap } from '../types'
import { ACTIVE, MAIN, addTurn, agentLabel, bar, buildTree, countByStatus, formatCompact, formatDuration, formatTokens, overThreshold, seedAgent, setModel, shortModel, tokensByModel, totals, usageLevel } from './ledger'
import type { AgentLike, Row } from './ledger'

// Cambia il tag se cambia la forma del valore: un reload con un altro tag lo legge come assente.
const usageAtom = atom({ plugin: 'agent-monitor', key: 'usage' } as const, {} as UsageMap, { shape: 'usage-1' })
const alertedAtom = atom({ plugin: 'agent-monitor', key: 'alerted' } as const, {} as AlertedMap, { shape: 'alerted-1' })
const agentsAtom = atom({ plugin: 'agent-monitor', key: 'agents' } as const, { list: [], stale: false, at: 0 } as AgentSnapshot, { shape: 'agents-1' })
const selectedAtom = atom({ plugin: 'agent-monitor', key: 'selected' } as const, '', { shape: 'selected-1' })
const PANE = 'agenti'

const LEVEL_COLOR = { ok: 'success', warn: 'warning', over: 'error' } as const
const STATUS_VIEW: Record<string, { glyph: string; label: string; color: string }> = {
  running: { glyph: '●', label: 'run', color: 'success' },
  idle: { glyph: '●', label: 'idle', color: 'success' },
  waiting: { glyph: '◐', label: 'att', color: 'warning' },
  pending: { glyph: '○', label: 'pend', color: 'subtle' },
  completed: { glyph: '✓', label: 'fin', color: 'inactive' },
  failed: { glyph: '✗', label: 'err', color: 'error' },
  killed: { glyph: '■', label: 'stop', color: 'error' },
}
const FINISHED = new Set(['completed', 'failed', 'killed'])
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const fit = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s.padEnd(w))

// Prefisso ad albero: ├/└ per il ramo, │ dove un antenato ha ancora fratelli sotto.
function treePrefix(rows: Row[], i: number): string {
  const d = rows[i]!.depth
  if (d === 0) return ''
  const hasLater = (k: number) => {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j]!.depth < k) return false
      if (rows[j]!.depth === k) return true
    }
    return false
  }
  let out = ''
  for (let k = 1; k < d; k++) out += hasLater(k) ? '│ ' : '  '
  return out + (hasLater(d) ? '├ ' : '└ ')
}

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
    const usage = await read($, usageAtom)
    await update($, agentsAtom, (prev) => {
      const fresh = list.map((a) => ({ id: a.id, parentId: a.parentId, status: a.status, name: a.name, description: a.description, type: a.type }))
      const seen = new Set(fresh.map((a) => a.id))
      // un agente sparito dall'elenco ma con consumi conserva etichetta e stato (se era attivo diventa completed)
      const kept = (prev?.list ?? [])
        .filter((a) => !seen.has(a.id) && a.id !== MAIN && usage[a.id])
        .map((a) => (ACTIVE.has(a.status) ? { ...a, status: 'completed' } : a))
      return { list: [...fresh, ...kept], stale: false, at }
    })
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
    const cols = e.props?.bodyColumns ?? 120
    const tot = totals(usage)
    const total = tot.input + tot.output

    // Selezione: quella scelta se l'agente c'è ancora, altrimenti il primo attivo (main escluso), altrimenti nessuna.
    const stored = await read($, selectedAtom)
    const selId = rows.some((r) => r.id === stored) ? stored : (rows.find((r) => r.id !== MAIN && ACTIVE.has(r.status))?.id ?? '')
    const sel = rows.find((r) => r.id === selId)

    // Colonne: < 70 niente TURNI né barra; < 50 solo glifo, nome e token.
    const narrow = cols < 70
    const tiny = cols < 50
    // Una sola definizione di colonne per intestazione e righe: stessa larghezza, il gap è l'ultima cella di ogni colonna.
    type Col = { id: string; header: string; w: number; keyed: boolean; text: (r: Row, i: number) => string; color?: (r: Row) => string | undefined }
    const tokenOf = (r: Row) => r.tokens.input + r.tokens.output
    const statusCol: Col = {
      id: 'status',
      header: 'STATO',
      w: tiny ? 2 : 8,
      keyed: true,
      text: (r) => {
        const v = STATUS_VIEW[r.status] ?? { glyph: '?', label: r.status, color: 'subtle' }
        return tiny ? v.glyph : `${v.glyph} ${v.label}`
      },
      color: (r) => (STATUS_VIEW[r.status] ?? { color: 'subtle' }).color,
    }
    const tail: Col[] = []
    if (!tiny) tail.push({ id: 'model', header: 'MODELLO', w: 9, keyed: false, text: (r) => (r.model ? shortModel(r.model) : '—') })
    tail.push({
      id: 'tokens',
      header: 'TOKEN',
      w: narrow ? 8 : 15,
      keyed: true,
      text: (r) => (narrow ? formatCompact(tokenOf(r)) : `${bar(tokenOf(r), limit, 6)} ${formatCompact(tokenOf(r))}`),
      color: (r) => (r.id === MAIN ? undefined : LEVEL_COLOR[usageLevel(tokenOf(r), limit)]),
    })
    if (!tiny) tail.push({ id: 'dur', header: 'DUR', w: 9, keyed: true, text: (r) => formatDuration(r.durationMs) })
    if (!narrow) tail.push({ id: 'turns', header: 'TURNI', w: 6, keyed: true, text: (r) => String(r.turns) })
    const labelW = Math.max(9, cols - 2 - statusCol.w - tail.reduce((n, c) => n + c.w, 0))
    const columns: Col[] = [statusCol, { id: 'label', header: 'AGENTE', w: labelW, keyed: true, text: (r, i) => treePrefix(rows, i) + r.label }, ...tail]
    const cell = (text: string, w: number) => fit(text, w - 1) + ' '

    const cnt = countByStatus(rows)
    const groups = [
      { key: 'active', n: cnt.active, text: `● ${cnt.active} attivi`, color: 'success' },
      { key: 'waiting', n: cnt.waiting, text: `◐ ${cnt.waiting} in attesa`, color: 'warning' },
      { key: 'pending', n: cnt.pending, text: `○ ${cnt.pending} in coda`, color: 'subtle' },
      { key: 'done', n: cnt.done, text: `✓ ${cnt.done} finiti`, color: 'inactive' },
      { key: 'failed', n: cnt.failed, text: `✗ ${cnt.failed} errori`, color: 'error' },
    ].filter((g) => g.n > 0)
    const budget = Number(opts?.sessionBudget ?? 0) || 0
    const level = LEVEL_COLOR[usageLevel(total, budget)]
    const budgetText = budget > 0 ? `Token ▕${bar(total, budget, 20)}▏ ${formatCompact(total)} / ${formatCompact(budget)}` : `Token ${formatCompact(total)}`
    const models = tokensByModel(usage).filter((m) => m.tokens > 0)

    const stop = async (r: Row) => {
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
    }

    return (
      <Box flexDirection="column">
        <Box key="summary" flexDirection="column" borderStyle="round" paddingX={1}>
          {groups.length > 0 && (
            <Box flexDirection="row" gap={2}>
              {groups.map((g) => (
                <Box key={`count-${g.key}`}><Text color={g.color}>
                  {g.text}
                </Text></Box>
              ))}
            </Box>
          )}
          <Box key="budget"><Text color={level}>
            {budgetText}
          </Text></Box>
          {models.length > 0 && (
            <Box key="models"><Text dimColor>
              {models.map((m) => `${cap(m.model)} ${formatCompact(m.tokens)}`).join(' · ')}
            </Text></Box>
          )}
        </Box>
        {snap.stale && <Text color="warning">elenco non aggiornato</Text>}
        <Box key="head"><Text dimColor bold>
          {'  ' + columns.map((c) => cell(c.header, c.w)).join('')}
        </Text></Box>
        {rows.map((r, i) => {
          const picked = r.id === selId
          const style = { dimColor: FINISHED.has(r.status) || undefined, bold: picked || undefined, inverse: picked || undefined }
          return (
            <Box key={`row-${r.id}`} flexDirection="row">
              <Button
                key={`sel-${r.id}`}
                plain
                label={picked ? '▸' : '○'}
                onPress={async () => {
                  await update($, selectedAtom, () => r.id)
                }}
              />
              <Text> </Text>
              {columns.map((c) => {
                const t = (
                  <Text key={c.id} color={c.color?.(r)} {...style}>
                    {cell(c.text(r, i), c.w)}
                  </Text>
                )
                return c.keyed ? <Box key={`${c.id}-${r.id}`}>{t}</Box> : t
              })}
            </Box>
          )
        })}
        {sel && sel.id !== MAIN ? (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Box key="actions"><Text bold>
                {sel.label}:
              </Text></Box>
              <Button
                key={`transcript-${sel.id}`}
                label="Transcript"
                onPress={() => {
                  void $.ui.view({ agentId: sel.id })
                }}
              />
              {ACTIVE.has(sel.status) && <Button key={`stop-${sel.id}`} label="Ferma" onPress={() => stop(sel)} />}
            </Box>
            <Box key="detail"><Text dimColor>
              {`id ${sel.id} · in ${formatCompact(sel.tokens.input)} · out ${formatCompact(sel.tokens.output)} · cache ${formatCompact(sel.tokens.cacheRead)}+${formatCompact(sel.tokens.cacheWrite)}`}
            </Text></Box>
          </Box>
        ) : (
          <Box key="actions"><Text dimColor>
            Seleziona un agente
          </Text></Box>
        )}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
