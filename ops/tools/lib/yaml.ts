/**
 * A deliberately small YAML reader for compose files: block mappings, block and flow
 * sequences of scalars, quoted scalars, comments. Every node remembers its line number so
 * findings can point at `compose.yaml:42`. Anchors, multi-line scalars and nested flow
 * mappings are not supported; compose files in this repository do not use them.
 */
export interface YamlNode {
  line: number
  value: string | YamlNode[] | Record<string, YamlNode>
}

interface Line {
  indent: number
  text: string
  line: number
}

export function parseYaml(source: string): YamlNode {
  const lines: Line[] = []
  source.split(/\r?\n/).forEach((raw, index) => {
    const text = stripComment(raw).trimEnd()
    if (!text.trim()) return
    lines.push({ indent: raw.length - raw.trimStart().length, text: text.trim(), line: index + 1 })
  })
  let position = 0

  function parseBlock(indent: number): YamlNode {
    const first = lines[position]
    if (!first) return { line: 0, value: {} }
    if (first.text.startsWith('- ') || first.text === '-') return parseSequence(indent)
    return parseMapping(indent)
  }

  function parseMapping(indent: number): YamlNode {
    const result: Record<string, YamlNode> = {}
    const startLine = lines[position]!.line
    while (position < lines.length && lines[position]!.indent === indent && !lines[position]!.text.startsWith('- ')) {
      const current = lines[position]!
      const match = current.text.match(/^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/)
      if (!match) {
        position++
        continue
      }
      const key = unquote(match[1]!)
      const rest = match[2]?.trim() ?? ''
      position++
      if (rest) {
        result[key] = { line: current.line, value: parseInline(rest, current.line) }
      } else if (position < lines.length && lines[position]!.indent > indent) {
        result[key] = { ...parseBlock(lines[position]!.indent), line: current.line }
      } else if (position < lines.length && lines[position]!.indent === indent && lines[position]!.text.startsWith('- ')) {
        // a sequence at the same indent as its key is legal YAML
        result[key] = { ...parseSequence(indent), line: current.line }
      } else {
        result[key] = { line: current.line, value: '' }
      }
    }
    return { line: startLine, value: result }
  }

  function parseSequence(indent: number): YamlNode {
    const items: YamlNode[] = []
    const startLine = lines[position]!.line
    while (position < lines.length && lines[position]!.indent === indent && (lines[position]!.text.startsWith('- ') || lines[position]!.text === '-')) {
      const current = lines[position]!
      const rest = current.text.slice(1).trim()
      position++
      if (!rest) {
        items.push(position < lines.length && lines[position]!.indent > indent ? parseBlock(lines[position]!.indent) : { line: current.line, value: '' })
      } else if (/^[^"'[{][^:]*:(\s|$)/.test(rest)) {
        // "- key: value" starts a mapping; its other keys follow on deeper-indented lines
        const itemIndent = indent + 2
        lines.splice(position, 0, { indent: itemIndent, text: rest, line: current.line })
        items.push(parseMapping(itemIndent))
      } else {
        items.push({ line: current.line, value: parseInline(rest, current.line) })
      }
    }
    return { line: startLine, value: items }
  }

  function parseInline(text: string, line: number): string | YamlNode[] {
    if (text.startsWith('[') && text.endsWith(']')) {
      const inner = text.slice(1, -1).trim()
      if (!inner) return []
      return splitFlow(inner).map(item => ({ line, value: unquote(item.trim()) }))
    }
    return unquote(text)
  }

  const root = parseBlock(lines[0]?.indent ?? 0)
  return root
}

function stripComment(text: string): string {
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i)
    }
  }
  return text
}

function splitFlow(inner: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ',') {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)
  return parts
}

function unquote(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

/** Helpers to walk the tree without caring about node shapes */
export function mapping(node: YamlNode | undefined): Record<string, YamlNode> {
  return node && typeof node.value === 'object' && !Array.isArray(node.value) ? node.value : {}
}

export function sequence(node: YamlNode | undefined): YamlNode[] {
  return node && Array.isArray(node.value) ? node.value : []
}

export function scalar(node: YamlNode | undefined): string | undefined {
  return node && typeof node.value === 'string' ? node.value : undefined
}

/** `environment` may be a mapping or a list of KEY=value strings; return [key, value, line] */
export function envEntries(node: YamlNode | undefined): [string, string, number][] {
  if (!node) return []
  if (Array.isArray(node.value)) {
    return node.value.map(item => {
      const text = scalar(item) ?? ''
      const eq = text.indexOf('=')
      return eq >= 0 ? [text.slice(0, eq), text.slice(eq + 1), item.line] : [text, '', item.line]
    })
  }
  return Object.entries(mapping(node)).map(([key, value]) => [key, scalar(value) ?? '', value.line])
}
