import { expect, mock, test } from 'claude-code/testing'
import type { On, PromptSubmitInput } from 'claude-code'

const ROOT = '/progetto'
const PLUGIN = '/plugin'
const LONG = ('Implementa il nuovo sistema di login in src/login.ts, deve avere test, criteri di accettazione e vincoli. ').repeat(8)
const BRIEF = '# Brief: login\n## Obiettivo\nx\n## Piano subagent\n### A\n## Verifica\nv\n---\nPrompt originale: p'
const ANALYSIS = JSON.stringify({ taglia: 'piccolo', lacune: [], domande: [], proposte: [] })
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const typed = (text: string, kind = 'composer'): PromptSubmitInput =>
  ({ text, wait: false, origin: { kind } }) as unknown as PromptSubmitInput

// replies: stringa = risposta; 'THROW' = rifiuto; 'FAIL' = non risposta
const world = (on: On, replies: string[] = [ANALYSIS, BRIEF], answers: (string | undefined)[] = [], env: Record<string, string> | null = {}) => {
  mock.store(on)
  if (env) mock.env(on, { HOME: '/home/u', ...env })
  const st = {
    files: new Map<string, string>([[`${PLUGIN}/assets/brief-template.md`, 'TPL'], [`${PLUGIN}/assets/linea-guida.md`, 'LG']]),
    prompts: [] as PromptSubmitInput[],
    asks: [] as string[],
    completes: 0,
    registered: [] as string[],
    replies: [...replies],
    answers: [...answers],
  }
  on('session.root', () => ({ value: ROOT }))
  on('fs.read', (_, e) => {
    const t = st.files.get(e.path)
    return t === undefined ? { deny: 'ENOENT' } : { value: t }
  })
  on('fs.write', (_, e) => {
    st.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) =>
    e.path === `${ROOT}/.git` ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' })
  on('command.run', (_, e) => ({ text: `/${e.command}` }))
  on('session.start', () => ({ cwd: ROOT }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('command.register', (_, e) => {
    st.registered.push(e.name)
    return { value: undefined } as never
  })
  on('prompt.submit', (_, e) => {
    st.prompts.push(e)
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('model.complete', (_, e) => {
    st.completes++
    const r = st.replies.shift()
    if (r === 'THROW') throw new Error('boom')
    if (r === 'FAIL') return { value: { isAnswered: false, reason: 'api-error', status: 500, usage } } as never
    return { value: { isAnswered: true, text: r ?? '', usage } } as never
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { deny: 'no' }
    const q = (e as unknown as { questions: { question: string }[] }).questions[0].question
    st.asks.push(q)
    const a = st.answers.shift()
    if (a === undefined) return { deny: 'dismissed' }
    return { result: { questions: [], answers: { [q]: a } } } as never
  })
  return st
}

test('origini diverse da composer: testo intatto, nessuna ask', async ($, on) => {
  const st = world(on)
  for (const kind of ['plugin', 'peer', 'peer-send-message', 'scheduled-trigger', 'task-notification', 'coordinator']) {
    const r = await $.prompt.submit(typed(LONG, kind))
    expect(r.text).toBe(LONG)
  }
  expect(st.asks.length).toBe(0)
  expect(st.completes).toBe(0)
})

test('!raw: prefisso tolto, nessuna ask', async ($, on) => {
  const st = world(on)
  const r = await $.prompt.submit(typed('!raw ' + LONG))
  expect(r.text.startsWith('!raw')).toBe(false)
  expect(r.text.trim()).toBe(LONG.trim())
  expect(st.asks.length).toBe(0)
})

test('testo corto: intatto, nessuna ask', async ($, on) => {
  const st = world(on)
  const r = await $.prompt.submit(typed('ciao'))
  expect(r.text).toBe('ciao')
  expect(st.asks.length).toBe(0)
})

test('enabled false: intatto', { options: { enabled: false } }, async ($, on) => {
  const st = world(on)
  const r = await $.prompt.submit(typed(LONG))
  expect(r.text).toBe(LONG)
  expect(st.asks.length).toBe(0)
})

test('conferma negativa: intatto, nessuna chiamata al modello', async ($, on) => {
  const st = world(on, [], ['No, invia così'])
  const r = await $.prompt.submit(typed(LONG))
  expect(r.text).toBe(LONG)
  expect(st.completes).toBe(0)
})

test('dialogo che rifiuta: intatto', async ($, on) => {
  const st = world(on, [], [])
  const r = await $.prompt.submit(typed(LONG))
  expect(r.text).toBe(LONG)
  expect(st.completes).toBe(0)
})

test('flusso completo: brief, last.md, exclude', async ($, on) => {
  const st = world(on, [ANALYSIS, BRIEF], ['Sì', 'Invia'])
  const r = await $.prompt.submit(typed(LONG))
  expect(r.text.includes('# Brief: login')).toBe(true)
  expect(st.files.get(`${ROOT}/.claude/prompt-builder/last.md`)).toBe(LONG)
  expect((st.files.get(`${ROOT}/.git/info/exclude`) ?? '').includes('.claude/prompt-builder/')).toBe(true)
})

test('errore del modello: originale con contesto di ripiego', async ($, on) => {
  world(on, ['FAIL', 'FAIL', 'FAIL'], ['Sì'])
  const r = await $.prompt.submit(typed(LONG))
  expect(r.text).toBe(LONG)
  expect((r.context ?? []).join(' ').includes('prompt-builder:prompt-builder')).toBe(true)
})

test('complete che lancia: mai persa, ripiego', async ($, on) => {
  world(on, ['THROW', 'THROW', 'THROW'], ['Sì'])
  const r = await $.prompt.submit(typed(LONG))
  expect(r.text).toBe(LONG)
  expect((r.context ?? []).join(' ').includes('prompt-builder:prompt-builder')).toBe(true)
})

test('/prompt-builder testo: nessuna conferma, submit con il brief', async ($, on) => {
  const st = world(on, [ANALYSIS, BRIEF], ['Invia'])
  await $.command.run({ command: 'prompt-builder', args: ' ' + LONG, origin: { kind: 'composer' }, presentation: 'text' } as never)
  for (let i = 0; i < 50 && st.prompts.length === 0; i++) await new Promise(r => setTimeout(r, 5))
  expect(st.asks.includes('Ottimizzo il prompt?')).toBe(false)
  expect(st.prompts.length).toBe(1)
  expect(st.prompts[0].text.includes('# Brief: login')).toBe(true)
  expect(JSON.stringify(st.prompts[0])).toContain('asUser')
})

test('/prompt-builder senza testo: uso, nessuna ask', async ($, on) => {
  const st = world(on)
  const r = await $.command.run({ command: 'prompt-builder', args: '  ', origin: { kind: 'composer' }, presentation: 'text' } as never)
  expect(r.text).toBe('Uso: /prompt-builder <testo del prompt>')
  expect(st.asks.length).toBe(0)
  expect(st.prompts.length).toBe(0)
})

test('session.start registra il comando', async ($, on) => {
  const st = world(on)
  await $.session.start({ cwd: ROOT } as never)
  expect(st.registered).toEqual(['prompt-builder'])
})

const BG = { CLAUDE_JOB_DIR: '/home/u/.claude/jobs/x' }

test('sessione in background: prompt lungo intatto, nessuna ask', async ($, on) => {
  const st = world(on, [ANALYSIS, BRIEF], [], BG)
  const r = await $.prompt.submit(typed(LONG))
  expect(r.text).toBe(LONG)
  expect(st.asks.length).toBe(0)
  expect(st.completes).toBe(0)
})

test('CLAUDE_JOB_DIR vuota: la domanda resta', async ($, on) => {
  const st = world(on, [ANALYSIS, BRIEF], [], { CLAUDE_JOB_DIR: '' })
  await $.prompt.submit(typed(LONG))
  expect(st.asks.includes('Ottimizzo il prompt?')).toBe(true)
})

test('background con !raw: prefisso tolto', async ($, on) => {
  world(on, [ANALYSIS, BRIEF], [], BG)
  const r = await $.prompt.submit(typed('!raw ' + LONG))
  expect(r.text.trim()).toBe(LONG.trim())
})

test('background: /prompt-builder compone ancora il brief', async ($, on) => {
  const st = world(on, [ANALYSIS, BRIEF], ['Invia'], BG)
  await $.command.run({ command: 'prompt-builder', args: ' ' + LONG, origin: { kind: 'composer' }, presentation: 'text' } as never)
  for (let i = 0; i < 50 && st.prompts.length === 0; i++) await new Promise(r => setTimeout(r, 5))
  expect(st.prompts.length).toBe(1)
  expect(st.prompts[0].text.includes('# Brief: login')).toBe(true)
})

test('env.get che rifiuta: la domanda resta', async ($, on) => {
  const st = world(on, [ANALYSIS, BRIEF], [], null)
  on('env.get', (_, e) => {
    if (e.name === 'CLAUDE_JOB_DIR') throw new Error('x')
    return { value: '/home/u' } as never
  })
  await $.prompt.submit(typed(LONG))
  expect(st.asks.includes('Ottimizzo il prompt?')).toBe(true)
})
