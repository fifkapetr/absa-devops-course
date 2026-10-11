/**
 * Minimal Dockerfile reader: instructions with their line numbers, continuation lines joined,
 * ARG defaults resolved in FROM lines, stages recognised.
 */
export interface Instruction {
  name: string      // FROM, RUN, USER, ...
  args: string      // everything after the instruction name
  line: number
}

export interface Stage {
  from: string          // image reference after ARG substitution
  alias?: string        // AS <name>
  fromLine: number
  instructions: Instruction[]
}

export function parseDockerfile(source: string): { instructions: Instruction[]; stages: Stage[]; args: Record<string, string> } {
  const instructions: Instruction[] = []
  const rawLines = source.split(/\r?\n/)
  let buffer = ''
  let startLine = 0
  rawLines.forEach((raw, index) => {
    const text = raw.trim()
    if (!buffer && (!text || text.startsWith('#'))) return
    if (!buffer) startLine = index + 1
    if (text.endsWith('\\')) {
      buffer += text.slice(0, -1) + ' '
      return
    }
    buffer += text
    const match = buffer.match(/^(\w+)\s*(.*)$/s)
    if (match) instructions.push({ name: match[1]!.toUpperCase(), args: match[2]!.trim(), line: startLine })
    buffer = ''
  })

  const args: Record<string, string> = {}
  const stages: Stage[] = []
  for (const instruction of instructions) {
    if (instruction.name === 'ARG') {
      const match = instruction.args.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/)
      if (match && match[2] !== undefined) args[match[1]!] = unquote(match[2])
    }
    if (instruction.name === 'FROM') {
      const parts = instruction.args.split(/\s+/).filter(part => !part.startsWith('--'))
      const image = substitute(parts[0] ?? '', args)
      const asIndex = parts.findIndex(part => part.toUpperCase() === 'AS')
      stages.push({ from: image, alias: asIndex >= 0 ? parts[asIndex + 1] : undefined, fromLine: instruction.line, instructions: [] })
    } else {
      stages.at(-1)?.instructions.push(instruction)
    }
  }
  return { instructions, stages, args }
}

function substitute(text: string, args: Record<string, string>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, fallback, bare) => {
    const name = braced ?? bare
    return args[name] ?? fallback ?? ''
  })
}

function unquote(text: string): string {
  const trimmed = text.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** KEY=value pairs (or the legacy `KEY value` form) of an ENV or ARG instruction */
export function keyValues(instruction: Instruction): [string, string][] {
  const pairs: [string, string][] = []
  const tokens = instruction.args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  if (tokens.length === 2 && !tokens[0]!.includes('=')) {
    pairs.push([tokens[0]!, unquote(tokens[1]!)])
    return pairs
  }
  for (const token of tokens) {
    const eq = token.indexOf('=')
    if (eq > 0) pairs.push([token.slice(0, eq), unquote(token.slice(eq + 1))])
    else pairs.push([token, ''])
  }
  return pairs
}
