import { createRng, hex, type Rng } from './random'

/**
 * Building blocks for the recorded incident logs: a timeline of lines from several services,
 * formatted the way the container pilot's log collector exports them (`service | <line>`),
 * with pino JSON for loan-api, nginx access/error lines for the gateway, Docker events and
 * timestamped plain lines for docs-search. Everything is driven by a seeded RNG.
 */
export interface SimLine {
  t: number          // epoch ms
  service: 'gateway' | 'loan-api' | 'docs-search' | 'docker'
  text: string
  seq: number
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function iso(t: number): string {
  return new Date(t).toISOString()
}

export function nginxClock(t: number): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
}

export function nginxErrorClock(t: number): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

export function dockerClock(t: number, rng: Rng): string {
  return iso(t).replace('Z', `${String(rng.int(0, 999999)).padStart(6, '0')}Z`)
}

export function utc(date: string, clock: string): number {
  return Date.parse(`${date}T${clock}${clock.length === 5 ? ':00' : ''}.000Z`)
}

export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'
]

export class Timeline {
  readonly lines: SimLine[] = []
  private seq = 0
  readonly rng: Rng

  constructor(seed: number) {
    this.rng = createRng(seed)
  }

  push(t: number, service: SimLine['service'], text: string) {
    this.lines.push({ t, service, text, seq: this.seq++ })
  }

  /** pino JSON line as loan-api writes it (OPS-060 format) */
  pino(t: number, level: number, pid: number, hostname: string, fields: Record<string, unknown>, msg: string) {
    this.push(t, 'loan-api', JSON.stringify({ level, time: iso(t), pid, hostname, ...fields, msg }))
  }

  /** nginx combined access line */
  access(t: number, client: string, method: string, url: string, status: number, bytes: number, referer: string, agent: string) {
    this.push(t, 'gateway', `${client} - - [${nginxClock(t)}] "${method} ${url} HTTP/1.1" ${status} ${bytes} "${referer}" "${agent}"`)
  }

  /** nginx error line for a failed upstream call */
  nginxError(t: number, severity: string, text: string, client: string, method: string, url: string, upstream: string, host: string) {
    const worker = `29#29: *${this.rng.int(1000, 99999)}`
    this.push(t, 'gateway', `${nginxErrorClock(t)} [${severity}] ${worker} ${text}, client: ${client}, server: , request: "${method} ${url} HTTP/1.1", upstream: "${upstream}", host: "${host}"`)
  }

  /** docker events line */
  dockerEvent(t: number, action: string, containerId: string, attrs: Record<string, string>) {
    const attrText = Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join(', ')
    this.push(t, 'docker', `${dockerClock(t, this.rng)} container ${action} ${containerId} (${attrText})`)
  }

  /** docs-search console line; the collector adds the timestamp */
  docs(t: number, text: string) {
    this.push(t, 'docs-search', `${iso(t)} ${text}`)
  }

  render(): string {
    const sorted = [...this.lines].sort((a, b) => a.t - b.t || a.seq - b.seq)
    return sorted.map(line => `${line.service.padEnd(11)} | ${line.text}`).join('\n') + '\n'
  }
}

export function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0
  const limit = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k++
    p *= rng.next()
  } while (p > limit)
  return k - 1
}

export function reqId(rng: Rng): string {
  return hex(rng, 8)
}

export function loanId(rng: Rng, t: number): string {
  return Math.floor(t / 1000).toString(36) + hex(rng, 7).replace(/[a-f]/g, c => String.fromCharCode(c.charCodeAt(0) + 10))
}

export function containerId(rng: Rng): string {
  return hex(rng, 64)
}
