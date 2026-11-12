import { expect, test } from 'claude-code/testing'

import { countSignals, isBackground, pastedRatio, shouldTrigger, stripRaw } from '../hooks/trigger'

const cfg = { minChars: 400, minSignals: 2 }
const pad = (head: string, n: number) => head + ' ' + 'lorem ipsum dolor sit amet '.repeat(40).slice(0, Math.max(0, n - head.length - 1))

test('countSignals conta i segnali', () => {
  expect(countSignals('Implementa il login.\n- form\n- validazione\nInoltre deve salvare in src/auth.ts')).toBe(4)
  expect(countSignals('ciao, come va?')).toBe(0)
})

test('pastedRatio riconosce i blocchi incollati', () => {
  expect(pastedRatio('guarda:\n```\n' + 'x\n'.repeat(50) + '```')).toBeGreaterThan(0.6)
})

test('stripRaw', () => {
  expect(stripRaw('!raw fai questo')).toBe('fai questo')
  expect(stripRaw('!raw   ')).toBe('')
  expect(stripRaw('fai !raw')).toBeUndefined()
})

test('shouldTrigger', () => {
  const two = 'Implementa il login. Inoltre deve salvare tutto.'
  const t450 = pad(two, 450)
  expect(t450.length).toBe(450)
  expect(shouldTrigger(t450, cfg)).toBe(true)
  expect(shouldTrigger(pad(two, 399), cfg)).toBe(false)
  expect(shouldTrigger(pad('Implementa il login.', 450), cfg)).toBe(false)
  const log = two + '\n' + '2026-11-12 ERROR boom something failed here\n'.repeat(46)
  expect(log.length).toBeGreaterThan(2000)
  expect(shouldTrigger(log, cfg)).toBe(false)
})

test('isBackground: vero solo con CLAUDE_JOB_DIR non vuota', () => {
  expect(isBackground(undefined)).toBe(false)
  expect(isBackground('')).toBe(false)
  expect(isBackground('/Users/u/.claude/jobs/abc')).toBe(true)
})
