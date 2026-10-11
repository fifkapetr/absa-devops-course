import { parseArgs, type ParseArgsConfig } from 'node:util'

type OptionSpec = NonNullable<ParseArgsConfig['options']>[string] & { description: string }

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
    spec[key] = rest
  }
  const { values, positionals } = parseArgs({ args: argv, options: spec, allowPositionals: true, strict: true })
  if (values.help) {
    console.log(`${name}\n\n${summary}\n\nOptions:`)
    for (const [key, option] of Object.entries(options)) {
      const flag = `--${key}${option.type === 'string' ? ' <value>' : ''}`
      const fallback = 'default' in option && option.default !== undefined ? ` (default: ${option.default})` : ''
      console.log(`  ${flag.padEnd(26)} ${option.description}${fallback}`)
    }
    console.log('  --help, -h                 Show this help')
    process.exit(0)
  }
  return { values: values as { [K in keyof T]: T[K]['type'] extends 'string' ? string : boolean }, positionals }
}
