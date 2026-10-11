import path from 'node:path'
import { parseArgs, type ParseArgsConfig } from 'node:util'

type OptionSpec = NonNullable<ParseArgsConfig['options']>[string] & { description: string }

/** The repository root (two levels above ops/tools/lib) */
export const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')

/** Resolve a user-supplied path; `\` and `/` are both accepted on every platform */
export function resolveInput(input: string): string {
  return path.resolve(repoRoot, input.replace(/\\/g, '/'))
}

/** A path for output: relative to the repository root, always with `/` */
export function displayPath(file: string): string {
  const relative = path.relative(repoRoot, file)
  return (relative && !relative.startsWith('..') ? relative : file).split(path.sep).join('/')
}

/**
 * Parse `--name value` options with Node's built-in parser and print a `--help` page.
 * Every ops tool uses this so the usage text looks the same everywhere.
 */
export function parseCli<T extends Record<string, OptionSpec>>(
  name: string,
  summary: string,
  options: T,
  argv = process.argv.slice(2)
) {
  const spec: ParseArgsConfig['options'] = { help: { type: 'boolean', short: 'h' } }
  for (const [key, option] of Object.entries(options)) {
    const { description: _description, ...rest } = option
    spec[key] = rest as NonNullable<ParseArgsConfig['options']>[string]
  }
  const { values, positionals } = parseArgs({ args: argv, options: spec, allowPositionals: true, strict: true })
  if (values.help) {
    console.log(`${name}\n\n${summary}\n\nOptions:`)
    for (const [key, option] of Object.entries(options)) {
      const flag = `--${key}${option.type === 'string' ? ' <value>' : ''}`
      const fallback = 'default' in option && option.default !== undefined ? ` (default: ${option.default})` : ''
      const repeat = 'multiple' in option && option.multiple ? ' (repeatable)' : ''
      console.log(`  ${flag.padEnd(26)} ${option.description}${fallback}${repeat}`)
    }
    console.log('  --help, -h                 Show this help')
    process.exit(0)
  }
  type Value<O> = O extends { multiple: true } ? string[] : O extends { type: 'string' } ? string : boolean
  return { values: values as { [K in keyof T]: Value<T[K]> }, positionals }
}
