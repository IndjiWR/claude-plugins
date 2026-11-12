// Caricamento delle linee guida (spec §6): predefinita, globale, progetto.

export type FileIO = {
  read(path: string): Promise<string | undefined>
  write(path: string, text: string): Promise<void>
}

const CLAUDE_MD_LIMIT = 3000

export async function loadGuidelines(
  io: FileIO,
  paths: { pluginRoot: string; home: string | undefined; projectRoot: string },
): Promise<{ text: string; createdGlobal: boolean }> {
  const defaultText = (await io.read(`${paths.pluginRoot}/assets/linea-guida.md`)) ?? ''
  let text = defaultText
  let createdGlobal = false

  if (paths.home) {
    const globalPath = `${paths.home}/.claude/prompt-builder/linea-guida.md`
    const existing = await io.read(globalPath)
    if (existing === undefined) {
      await io.write(globalPath, defaultText)
      createdGlobal = true
    } else {
      text = existing
    }
  }

  const project = await io.read(`${paths.projectRoot}/.claude/prompt-builder.md`)
  if (project !== undefined) {
    text += '\n\n## Progetto (prevale sulla globale)\n' + project
  } else {
    const claudeMd = await io.read(`${paths.projectRoot}/CLAUDE.md`)
    if (claudeMd !== undefined) {
      text += '\n\n## Contesto del progetto (da CLAUDE.md)\n' + claudeMd.slice(0, CLAUDE_MD_LIMIT)
    }
  }
  return { text, createdGlobal }
}
