/**
 * Parsers for the log formats that appear in the container pilot's combined log:
 * pino JSON (loan-api), nginx access and error lines (gateway), Docker events and plain
 * lines with a leading timestamp (docs-search). Lines may carry a `service | ` prefix
 * as written by `docker compose logs`. Used by `npm run logs` and by the tests.
 */
export interface ParsedLine {
  service: string
  time?: string     // ISO 8601 UTC
  level: number     // 30 info, 40 warn, 50 error (derived for non-pino lines)
  msg?: string
  status?: number
  kind: 'pino' | 'nginx-access' | 'nginx-error' | 'docker' | 'text'
}

export const LEVEL_NAMES: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }
const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }

const PREFIX = /^([A-Za-z0-9_.-]+)\s*\|\s(.*)$/
const NGINX_ACCESS = /^\S+ \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{4})\] "(\S+) (\S+) [^"]*" (\d{3}) /
const NGINX_ERROR = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2}) \[(\w+)\] /
const DOCKER_EVENT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (\w+) (\w+) /
const LEADING_ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/

export function parseLine(raw: string): ParsedLine {
  let service = '-'
  let content = raw
  const prefixed = raw.match(PREFIX)
  if (prefixed) {
    service = prefixed[1]!
    content = prefixed[2]!
  }

  if (content.startsWith('{')) {
    try {
      const json = JSON.parse(content) as Record<string, unknown>
      return {
        service: service === '-' && typeof json.service === 'string' ? json.service : service,
        time: typeof json.time === 'string' ? json.time : typeof json.time === 'number' ? new Date(json.time).toISOString() : undefined,
        level: typeof json.level === 'number' ? json.level : LEVEL_NAMES[String(json.level)] ?? 30,
        msg: typeof json.msg === 'string' ? json.msg : undefined,
        status: typeof json.status === 'number' ? json.status : undefined,
        kind: 'pino'
      }
    } catch {
      // not JSON after all
    }
  }

  const access = content.match(NGINX_ACCESS)
  if (access) {
    const [, day, mon, year, clock, zone, method, url, status] = access
    const time = toUtc(`${year}-${MONTHS[mon!] ?? '01'}-${day}T${clock}`, zone!)
    const code = Number(status)
    return { service, time, level: code >= 500 ? 50 : code >= 400 ? 40 : 30, msg: `${method} ${url}`, status: code, kind: 'nginx-access' }
  }

  const error = content.match(NGINX_ERROR)
  if (error) {
    const [, year, month, day, clock, severity] = error
    return {
      service,
      time: `${year}-${month}-${day}T${clock}.000Z`,
      level: severity === 'warn' || severity === 'notice' ? 40 : severity === 'info' ? 30 : 50,
      msg: content.replace(NGINX_ERROR, '').split(',')[0]?.replace(/^\d+#\d+: \*\d+ /, '').trim(),
      kind: 'nginx-error'
    }
  }

  const event = content.match(DOCKER_EVENT)
  if (event) {
    const [, time, type, action] = event
    return { service, time, level: action === 'oom' || action === 'die' ? 50 : action === 'kill' ? 40 : 30, msg: `${type} ${action}`, kind: 'docker' }
  }

  const iso = content.match(LEADING_ISO)
  return { service, time: iso?.[1], level: /\b(error|fatal|EACCES|ECONNREFUSED)\b/i.test(content) ? 50 : /\bwarn/i.test(content) ? 40 : 30, kind: 'text' }
}

function toUtc(local: string, zone: string): string {
  const sign = zone.startsWith('-') ? -1 : 1
  const offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)))
  const date = new Date(`${local}Z`)
  date.setUTCMinutes(date.getUTCMinutes() - offsetMinutes)
  return date.toISOString()
}

export function redact(line: string): string {
  return line
    .replace(/("applicantName"\s*:\s*")[^"]*(")/g, '$1[REDACTED]$2')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED-EMAIL]')
    .replace(/([?&]token=)[^&\s"']+/g, '$1[REDACTED]')
}
