import type { Register } from 'claude-code'
import { loadGuidelines } from './guideline'
import type { FileIO } from './guideline'
import { runPipeline } from './pipeline'
import type { AskFn, CompleteFn, PipelineResult } from './pipeline'
import { shouldTrigger, stripRaw } from './trigger'

type Config = { enabled: boolean; minChars: number; minSignals: number; model: string; maxQuestions: number }

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

const readConfig = (o: Record<string, unknown>): Config => ({
  enabled: o.enabled !== false,
  minChars: num(o.minChars, 400),
  minSignals: num(o.minSignals, 2),
  model: typeof o.model === 'string' && o.model ? o.model : 'sonnet',
  maxQuestions: Math.min(8, Math.max(0, Math.round(num(o.maxQuestions, 5)))),
})

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const EXCLUDE_LINE = '.claude/prompt-builder/'
const USAGE = 'Uso: /prompt-builder <testo del prompt>'

const fallbackNote = (reason: string) =>
  `Il prompt-builder non ha potuto comporre il brief (${reason}): usa la skill prompt-builder:prompt-builder per chiarire obiettivo, criteri e metodo prima di iniziare.`

// Mai lanciare: ogni errore diventa il ramo di ripiego, il prompt non va perso.
async function build($: any, text: string, cfg: Config): Promise<PipelineResult & { root?: string }> {
  try {
    const io: FileIO = {
      read: async path => {
        try {
          return await $.fs.read(path)
        } catch {
          return undefined
        }
      },
      write: async (path, t) => {
        await $.fs.write(path, t)
      },
    }
    const root: string = await $.session.root()
    const home: string | undefined = await $.env.get('HOME')
    const { text: guidelines } = await loadGuidelines(io, { pluginRoot: $.plugin.root, home, projectRoot: root })
    const template = (await io.read(`${$.plugin.root}/assets/brief-template.md`)) ?? ''
    const ask: AskFn = async (question, opts) => {
      try {
        return await $.ui.ask(question, opts)
      } catch {
        return undefined
      }
    }
    const complete: CompleteFn = async prompt => {
      try {
        const r = await $.model.complete({ model: cfg.model, prompt, timeoutMs: 60000 })
        const u = r.usage
        const usage = u
          ? { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens }
          : { ...ZERO }
        return r.isAnswered ? { text: r.text, usage } : { text: undefined, usage }
      } catch {
        return { text: undefined, usage: { ...ZERO } }
      }
    }
    const result = await runPipeline(text, { ask, complete, guidelines, template, maxQuestions: cfg.maxQuestions })
    return { ...result, root }
  } catch (err) {
    return { kind: 'fallback', reason: err instanceof Error ? err.message : 'errore imprevisto' }
  }
}

// Salva l'originale e registra la taglia; errori ignorati (il brief va comunque inviato).
async function archive($: any, original: string, r: Extract<PipelineResult, { kind: 'brief' }>, root: string) {
  try {
    await $.fs.write(`${root}/.claude/prompt-builder/last.md`, original)
    const excludePath = `${root}/.git/info/exclude`
    const hasGit = await $.fs.stat(`${root}/.git`).then(() => true, () => false)
    if (hasGit) {
      const cur: string = await $.fs.read(excludePath).catch(() => '')
      if (!cur.split(/\r?\n/).includes(EXCLUDE_LINE)) {
        await $.fs.write(excludePath, cur + (cur === '' || cur.endsWith('\n') ? '' : '\n') + EXCLUDE_LINE + '\n')
      }
    }
    const s = r.stats
    const tokens = s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite
    $.ui.log(
      `prompt-builder: brief pronto (taglia ${s.taglia}, ${s.domande} domande, proposte ${s.proposteAccettate}/${s.proposteTotali}, ${tokens} token)`,
    )
  } catch {
    /* ignorato */
  }
}


async function runCommand($: any, text: string, cfg: Config): Promise<void> {
  try {
    const r = await build($, text, cfg)
    if (r.kind === 'brief') {
      await archive($, text, r, r.root ?? '')
      await $.prompt.submit({ text: r.text })
    } else if (r.kind === 'fallback') {
      await $.prompt.submit({ text: `${text}\n\n[${fallbackNote(r.reason)}]` })
    } else {
      await $.prompt.submit({ text })
    }
  } catch {
    await $.prompt.submit({ text }).catch(() => undefined)
  }
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompt-builder',
      description: 'Trasforma il prompt in un brief chiaro (intervista e proposte)',
      argumentHint: '[testo]',
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' || e.command) return next(e)
    const stripped = stripRaw(e.text)
    if (stripped !== undefined) return next({ ...e, text: stripped })
    if (!cfg.enabled || !shouldTrigger(e.text, cfg)) return next(e)
    let answer: string | undefined
    try {
      answer = await $.ui.ask('Ottimizzo il prompt?', ['Sì', 'No, invia così'])
    } catch {
      return next(e)
    }
    if (answer !== 'Sì') return next(e)
    const r = await build($, e.text, cfg)
    if (r.kind === 'brief') {
      await archive($, e.text, r, r.root ?? '')
      return next({ ...e, text: r.text })
    }
    if (r.kind === 'fallback') return next({ ...e, context: [...(e.context ?? []), fallbackNote(r.reason)] })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'prompt-builder' }, async ($, e, next) => {
    const text = e.args.trim()
    if (!text) return { text: USAGE }
    // prompt.submit non si può chiamare mentre il comando tiene il turno: il lavoro parte staccato.
    void runCommand($, text, cfg)
    return { text: 'Preparo il brief…' }
  }).catch(($, e, next) => next(e))
}
