// Regole di rilevamento (spec §4): funzioni pure, zero token.

export type TriggerConfig = { minChars: number; minSignals: number }

const VERB =
  /\b(implementa\w*|crea\w*|costruisc\w*|aggiung\w*|refactor\w*|migra\w*|integra\w*|progetta\w*|sviluppa\w*|correggi\w*|realizza\w*|scrivi|modifica\w*|implement|create|build|add|migrate|integrate|design|develop|fix|write|set up)\b/i
const LIST = /^\s*(?:[-*•]|\d+[.)])\s+\S/m
const REQUIREMENTS = /\b(e poi|inoltre|deve|devono|dovrebbe|also|must|should|then)\b/i
const PATH = /(?:\b[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|css|html|yml|yaml|toml|sh|sql)\b)/i
const PROJECT = /\b(progetto|feature|app|sistema|project|system|application)\b/i

const LOG = /^\s*(at |\d{4}-\d\d-\d\d|\[?(ERROR|WARN|INFO|DEBUG)\b|Traceback|File ")/

export function countSignals(text: string): number {
  return [VERB, LIST, REQUIREMENTS, PATH, PROJECT].filter((re) => re.test(text)).length
}

export function pastedRatio(text: string): number {
  if (text.length === 0) return 0
  let pasted = 0
  let fenced = false
  for (const line of text.split('\n')) {
    const size = line.length + 1
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      pasted += size
    } else if (fenced || /^( {4,}|\t)/.test(line) || LOG.test(line)) {
      pasted += size
    }
  }
  return Math.min(1, pasted / text.length)
}

export function stripRaw(text: string): string | undefined {
  const m = /^!raw(?:\s+|$)/.exec(text)
  return m ? text.slice(m[0].length) : undefined
}

// Sessioni `claude --bg`: CLAUDE_JOB_DIR non vuota.
export function isBackground(jobDir: string | undefined): boolean {
  return typeof jobDir === 'string' && jobDir !== ''
}

export function shouldTrigger(text: string, cfg: TriggerConfig): boolean {
  return text.length >= cfg.minChars && countSignals(text) >= cfg.minSignals && pastedRatio(text) <= 0.6
}
