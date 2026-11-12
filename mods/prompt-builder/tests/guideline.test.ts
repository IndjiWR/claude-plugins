import { expect, test } from 'claude-code/testing'

import { loadGuidelines, type FileIO } from '../hooks/guideline'

const PLUGIN = '/plugin'
const HOME = '/home/u'
const PROJ = '/proj'
const DEFAULT_PATH = `${PLUGIN}/assets/linea-guida.md`
const GLOBAL_PATH = `${HOME}/.claude/prompt-builder/linea-guida.md`
const PROJECT_PATH = `${PROJ}/.claude/prompt-builder.md`
const CLAUDE_PATH = `${PROJ}/CLAUDE.md`

function fakeIO(files: Record<string, string>) {
  const m = new Map(Object.entries(files))
  const writes: Array<[string, string]> = []
  const io: FileIO = {
    read: async (p) => m.get(p),
    write: async (p, t) => {
      writes.push([p, t])
      m.set(p, t)
    },
  }
  return { io, writes }
}

const paths = { pluginRoot: PLUGIN, home: HOME, projectRoot: PROJ }

test('solo globale', async () => {
  const { io, writes } = fakeIO({ [DEFAULT_PATH]: 'DEFAULT', [GLOBAL_PATH]: 'GLOBALE' })
  const r = await loadGuidelines(io, paths)
  expect(r.text).toContain('GLOBALE')
  expect(r.createdGlobal).toBe(false)
  expect(writes.length).toBe(0)
})

test('globale assente e creata', async () => {
  const { io, writes } = fakeIO({ [DEFAULT_PATH]: 'DEFAULT' })
  const r = await loadGuidelines(io, paths)
  expect(writes).toEqual([[GLOBAL_PATH, 'DEFAULT']])
  expect(r.createdGlobal).toBe(true)
  expect(r.text).toContain('DEFAULT')
})

test('globale + progetto', async () => {
  const { io } = fakeIO({ [GLOBAL_PATH]: 'GLOBALE', [PROJECT_PATH]: 'PROGETTO' })
  const r = await loadGuidelines(io, paths)
  const head = '## Progetto (prevale sulla globale)'
  expect(r.text).toContain(head)
  expect(r.text.indexOf(head)).toBeGreaterThan(r.text.indexOf('GLOBALE'))
  expect(r.text).toContain('PROGETTO')
})

test('globale + CLAUDE.md troncato', async () => {
  const { io } = fakeIO({ [GLOBAL_PATH]: 'GLOBALE', [CLAUDE_PATH]: 'a'.repeat(3000) + 'b'.repeat(2000) })
  const r = await loadGuidelines(io, paths)
  expect(r.text).toContain('## Contesto del progetto (da CLAUDE.md)')
  expect(r.text).toContain('a'.repeat(3000))
  expect(r.text).not.toContain('b')
})

test('home assente', async () => {
  const { io, writes } = fakeIO({ [DEFAULT_PATH]: 'DEFAULT' })
  const r = await loadGuidelines(io, { ...paths, home: undefined })
  expect(r.text).toBe('DEFAULT')
  expect(r.createdGlobal).toBe(false)
  expect(writes.length).toBe(0)
})
