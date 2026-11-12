import { expect, test } from 'claude-code/testing'

import { attachCommand, isAttachId, mergeSessions, parseAgents, parseRegistry } from '../hooks/sessions'
import type { LiveSession, RegistryEntry } from '../hooks/sessions'

const NOW = Date.parse('2026-11-12T15:00:00')
const live = (o: Partial<LiveSession> & { id: string }): LiveSession => ({ name: o.id, cwd: '/a/b/proj', ...o })
const reg = (o: Partial<RegistryEntry> & { id: string }): RegistryEntry => ({ project: 'p', name: 'n', stato: 'avviata', ...o })

test('parseAgents tiene solo i background e mappa i campi', () => {
  const text = JSON.stringify([
    { kind: 'background', id: 'abc123', name: 'pf', cwd: '/x/pf', state: 'working', status: 'running', waitingFor: 'w', sessionId: 's1' },
    { kind: 'foreground', id: 'ffffff', name: 'fg', cwd: '/x' },
    { kind: 'background', name: 'senza id' },
  ])
  expect(parseAgents(text)).toEqual([{ id: 'abc123', name: 'pf', cwd: '/x/pf', state: 'working', status: 'running', waitingFor: 'w', sessionId: 's1' }])
})

test('parseAgents legge dal primo [ e tollera testo non valido', () => {
  const out = parseAgents('Starting background service…\n' + JSON.stringify([{ kind: 'background', id: 'abc123', name: 'a', cwd: '/c' }]))
  expect(out.length).toBe(1)
  expect(parseAgents('non json')).toEqual([])
  expect(parseAgents('{}')).toEqual([])
})

test('parseRegistry esclude la coordinatrice e mappa i campi', () => {
  const text = '{"coordinatrice":{"nome":"c","id":"aaaaaa"},"pf":{"nome":"pf","id":"e003551f","stato":"avviata","ora":"2026-11-12T13:46:00","esito":"ok","esito_ora":"2026-11-12T14:00:00"}}'
  expect(parseRegistry(text)).toEqual([
    { project: 'pf', name: 'pf', id: 'e003551f', stato: 'avviata', ora: '2026-11-12T13:46:00', esito: 'ok', esitoOra: '2026-11-12T14:00:00' },
  ])
})

test('parseRegistry: JSON non valido e voci senza id', () => {
  expect(parseRegistry('{rotto')).toEqual([])
  expect(parseRegistry('{"pf":{"nome":"pf"}}')).toEqual([])
})

test('mergeSessions: viva con voce nel registro usa project ed esito del registro', () => {
  const r = mergeSessions([live({ id: 'abc123' })], [reg({ id: 'abc123', project: 'pf', esito: 'ok', esitoOra: '2026-11-12T14:00:00' })], NOW)
  expect(r[0].project).toBe('pf')
  expect(r[0].esito).toBe('ok')
  expect(r[0].esitoOra).toBe('2026-11-12T14:00:00')
})

test('mergeSessions: viva senza voce usa ultimo segmento del cwd', () => {
  const r = mergeSessions([live({ id: 'abc123', cwd: '/a/b/claude-plugins' })], [], NOW)
  expect(r[0].project).toBe('claude-plugins')
})

test('mergeSessions: stati', () => {
  const r = mergeSessions([
    live({ id: 'aaaaaa', name: 'w', state: 'working' }),
    live({ id: 'bbbbbb', name: 'b', state: 'blocked', waitingFor: 'permesso' }),
    live({ id: 'cccccc', name: 'c', status: 'waiting' }),
    live({ id: 'dddddd', name: 'd', state: 'boh' }),
  ], [], NOW)
  const by = (n: string) => r.find(s => s.name === n)!
  expect(by('w').state).toBe('working')
  expect(by('b').state).toBe('blocked')
  expect(by('b').reason).toBe('permesso')
  expect(by('c').state).toBe('blocked')
  expect(by('d').state).toBe('idle')
})

test('mergeSessions: chiuse entro 24 h incluse, oltre escluse, ore non valide escluse', () => {
  const h = (n: number) => new Date(NOW - n * 3_600_000).toISOString()
  const r = mergeSessions([], [
    reg({ id: 'aaaaaa', name: 'recente', esitoOra: h(1) }),
    reg({ id: 'bbbbbb', name: 'vecchia', esitoOra: h(25) }),
    reg({ id: 'cccccc', name: 'rotta', ora: 'boh', esitoOra: 'boh' }),
  ], NOW)
  expect(r.map(s => s.name)).toEqual(['recente'])
  expect(r[0].state).toBe('closed')
})

test('mergeSessions: esclude la sessione stessa', () => {
  const r = mergeSessions([live({ id: 'aaaaaa', sessionId: 'me' }), live({ id: 'bbbbbb', sessionId: 'altra' })], [], NOW, 'me')
  expect(r.map(s => s.id)).toEqual(['bbbbbb'])
})

test('mergeSessions: ordine per stato poi nome', () => {
  const r = mergeSessions([
    live({ id: 'aaaaaa', name: 'z', state: 'working' }),
    live({ id: 'bbbbbb', name: 'b', state: 'idle' }),
    live({ id: 'cccccc', name: 'a', state: 'idle' }),
    live({ id: 'dddddd', name: 'y', state: 'blocked' }),
  ], [reg({ id: 'eeeeee', name: 'c', esitoOra: new Date(NOW - 3_600_000).toISOString() })], NOW)
  expect(r.map(s => s.name)).toEqual(['y', 'z', 'a', 'b', 'c'])
})

test('isAttachId e attachCommand', () => {
  expect(isAttachId('e003551f')).toBe(true)
  expect(isAttachId('x"; rm')).toBe(false)
  expect(attachCommand('e003551f')).toBe('claude attach e003551f')
})

test('mergeSessions porta sessionId della viva; le chiuse solo-registro non lo hanno', () => {
  const r = mergeSessions([live({ id: 'abc123', sessionId: 'sid-1' })], [reg({ id: 'dead01', stato: 'chiusa', ora: '2026-11-12T14:00:00' })], NOW)
  expect(r.find(s => s.id === 'abc123')?.sessionId).toBe('sid-1')
  const closed = r.find(s => s.id === 'dead01')
  expect(closed).toBeDefined()
  expect(closed?.sessionId).toBeUndefined()
})
