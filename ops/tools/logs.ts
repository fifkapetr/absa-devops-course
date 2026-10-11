import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { displayPath, parseCli, resolveInput } from './lib/cli'
import { LEVEL_NAMES, parseLine, redact } from './lib/logFormats'

/**
 * npm run logs
 *
 * Cross-platform log reader for big files. Streams line by line and understands the formats that
 * appear in the container pilot's combined log: pino JSON (loan-api), nginx access and error lines
 * (gateway), Docker events, and plain lines with a leading timestamp (docs-search). Lines may carry
 * a `service | ` prefix as written by `docker compose logs`.
 */
const { values } = parseCli(
  'npm run logs',
  'Filters, counts and redacts application and container logs; no external tools needed, same options in every shell.',
  {
    file: { type: 'string', default: 'logs/app.log', description: 'Log file to read' },
    service: { type: 'string', description: 'Only lines of this service prefix (gateway, loan-api, docs-search, docker)' },
    level: { type: 'string', description: 'Minimum level: 30/40/50 or info/warn/error (nginx and docker lines are mapped)' },
    from: { type: 'string', description: 'Only lines at or after this ISO time (UTC), e.g. 2026-10-05T07:00:00Z' },
    to: { type: 'string', description: 'Only lines before this ISO time (UTC)' },
    grep: { type: 'string', multiple: true, description: 'Only lines matching this regular expression (case-insensitive); several --grep mean OR' },
    msg: { type: 'string', description: 'Only pino lines whose msg contains this text' },
    status: { type: 'string', description: 'Only lines with this HTTP status, e.g. 502 or 5xx' },
    redact: { type: 'boolean', default: false, description: 'Mask applicant names, e-mail addresses and token= query values' },
    count: { type: 'boolean', default: false, description: 'Print counts by service, level, msg and status instead of lines' },
    head: { type: 'string', description: 'Print only the first N matching lines' },
    tail: { type: 'string', description: 'Print only the last N matching lines' },
    'line-numbers': { type: 'boolean', default: false, description: 'Prefix each printed line with its line number in the file' }
  }
)

function levelThreshold(input?: string): number | undefined {
  if (!input) return undefined
  if (/^\d+$/.test(input)) return Number(input)
  const level = LEVEL_NAMES[input.toLowerCase()]
  if (level === undefined) {
    console.error(`logs: unknown level "${input}"; use 30/40/50 or info/warn/error`)
    process.exit(2)
  }
  return level
}

function statusMatches(status: number | undefined, filter?: string): boolean {
  if (!filter) return true
  if (status === undefined) return false
  if (/^\dxx$/i.test(filter)) return Math.floor(status / 100) === Number(filter[0])
  return status === Number(filter)
}

async function main() {
  const minLevel = levelThreshold(values.level)
  const from = values.from ? Date.parse(values.from) : undefined
  const to = values.to ? Date.parse(values.to) : undefined
  if ((values.from && Number.isNaN(from)) || (values.to && Number.isNaN(to))) {
    console.error('logs: --from/--to must be ISO 8601 timestamps, e.g. 2026-10-05T07:00:00Z')
    process.exit(2)
  }
  const patterns = (values.grep ?? []).map(expression => new RegExp(expression, 'i'))
  const head = values.head ? Number(values.head) : undefined
  const tail = values.tail ? Number(values.tail) : undefined
  const ring: string[] = []
  const file = resolveInput(values.file)

  const counts = { service: new Map<string, number>(), level: new Map<string, number>(), msg: new Map<string, number>(), status: new Map<string, number>() }
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)

  let lineNumber = 0
  let matched = 0
  let unparsableTime = 0
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity })

  for await (const line of reader) {
    lineNumber++
    const raw = line.replace(/\r$/, '') // a CRLF checkout must give the same output as an LF one
    if (!raw.trim()) continue
    const parsed = parseLine(raw)
    if (values.service && parsed.service !== values.service) continue
    if (minLevel !== undefined && parsed.level < minLevel) continue
    if (from !== undefined || to !== undefined) {
      if (!parsed.time) {
        unparsableTime++
        continue
      }
      const t = Date.parse(parsed.time)
      if (from !== undefined && t < from) continue
      if (to !== undefined && t >= to) continue
    }
    if (values.msg && !(parsed.msg ?? '').includes(values.msg)) continue
    if (!statusMatches(parsed.status, values.status)) continue
    if (patterns.length && !patterns.some(pattern => pattern.test(raw))) continue

    matched++
    if (values.count) {
      bump(counts.service, parsed.service)
      bump(counts.level, String(parsed.level))
      bump(counts.msg, parsed.msg ?? `(${parsed.kind})`)
      if (parsed.status !== undefined) bump(counts.status, String(parsed.status))
      continue
    }
    const text = values.redact ? redact(raw) : raw
    const output = values['line-numbers'] ? `${lineNumber}: ${text}` : text
    if (tail !== undefined) {
      ring.push(output)
      if (ring.length > tail) ring.shift()
      continue
    }
    console.log(output)
    if (head !== undefined && matched >= head) break
  }
  for (const output of ring) console.log(output)

  if (values.count) {
    console.log(`matched ${matched} of ${lineNumber} lines in ${displayPath(file)}`)
    for (const [title, map] of Object.entries(counts)) {
      if (map.size === 0) continue
      console.log(`\nby ${title}:`)
      for (const [key, value] of [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
        console.log(`  ${String(value).padStart(8)}  ${key}`)
      }
    }
  }
  if (unparsableTime) console.error(`logs: ${unparsableTime} line(s) skipped by the time filter because they carry no timestamp`)
}

void main()
