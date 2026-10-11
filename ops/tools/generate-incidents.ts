import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseCli } from './lib/cli'
import { fakeApplicantName, SEARCH_QUESTIONS } from './lib/fakeData'
import { containerId, iso, loanId, poisson, reqId, Timeline, USER_AGENTS, utc } from './lib/incidentSim'
import type { Rng } from './lib/random'

/**
 * Generates the recorded logs of the two training incidents (fixed seeds, reproducible):
 *   incident/INC-20261005-01/logs/combined.log + metrics.csv   (restart loop, S2)
 *   incident/INC-20261007-01/logs/combined.log + metrics.csv   (lost applications, S2)
 * The chat exports, e-mails and tickets next to them are written by hand from the numbers
 * this script prints; regenerate with the same seed and they stay consistent.
 */
const { values } = parseCli(
  'npx tsx ops/tools/generate-incidents.ts',
  'Regenerates the recorded incident logs and metrics with fixed seeds.',
  {
    out: { type: 'string', default: 'incident', description: 'Output folder' },
    only: { type: 'string', description: 'Generate one incident id only' }
  }
)

const HOST = 'cz-prg-01-pilot:8080'
const REFERER = `http://${HOST}/`
const UPSTREAM = { api: 'http://172.18.0.4:3000', docs: 'http://172.18.0.3:3001' }
const DOCKER_HOST_IP = '172.18.0.1'
const TOKEN = 'FAKE-docs-admin-7f3a'
const DEPRECATION = [
  '(node:PID) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.',
  '(Use `node --trace-deprecation ...` to show where the warning was created)'
]

interface Rates {
  calc: number
  list: number
  docs: number
  health: number
  quote: number
  create: number
  decide: number
}

interface Session {
  name: string
  amount: number
  term: number
  rate: number
  left: number
}

interface ApiState {
  up: boolean
  version: '1.1.0' | '1.2.0'
  containerId: string
  hostname: string
  pid: number
  startedAt: number
  entries: number
  heapBase: number
  persistenceDisabled: boolean
  restarts: number
}

const RATE_BANDS = [0.05, 0.06, 0.07, 0.075, 0.08, 0.085, 0.09, 0.1]

function officerIp(rng: Rng): string {
  return `10.20.7.${rng.int(21, 44)}`
}

function pino500(message: string, frame: string) {
  return {
    type: 'AuditWriteError',
    message,
    stack: `AuditWriteError: ${message}\n    at Object.record (/app/server/auditLog.ts:${frame})\n    at Object.updateStatus (/app/server/loanService.ts:44:7)\n    at <anonymous> (/app/server/app.ts:93:30)`
  }
}

// ---------------------------------------------------------------------------------------------
// Shared traffic simulation for one day
// ---------------------------------------------------------------------------------------------
class DaySim {
  readonly tl: Timeline
  readonly rng: Rng
  readonly api: ApiState
  readonly sessions: Session[] = []
  readonly dayNames: string[]
  readonly pending: string[] = ['ln-1003', 'ln-1004', 'ln-1006']
  readonly decided = new Set<string>(['ln-1001', 'ln-1002', 'ln-1005'])
  loanCount = 6
  memoryLimitMB: number
  memoryBaseMB: number
  oomKills: number[] = []
  starts: { t: number; version: string }[] = []
  pendingBoot: { at: number; version: '1.1.0' | '1.2.0'; recreate: boolean; persistenceDisabled: boolean } | undefined
  metrics: string[] = ['timestamp_utc,service,cpu_pct,mem_mb,restarts']
  cpuLoad = 0
  dayNameCount: number

  constructor(seed: number, dayNameCount: number, memoryLimitMB: number, memoryBaseMB: number) {
    this.tl = new Timeline(seed)
    this.rng = this.tl.rng
    this.dayNameCount = dayNameCount
    this.memoryLimitMB = memoryLimitMB
    this.memoryBaseMB = memoryBaseMB
    const names = new Set<string>()
    while (names.size < dayNameCount) names.add(fakeApplicantName(this.rng))
    this.dayNames = [...names]
    this.api = {
      up: true,
      version: '1.1.0',
      containerId: containerId(this.rng),
      hostname: '',
      pid: 7,
      startedAt: 0,
      entries: 0,
      heapBase: 18,
      persistenceDisabled: false,
      restarts: 0
    }
    this.api.hostname = this.api.containerId.slice(0, 12)
  }

  heapUsedMB(): number {
    return this.api.heapBase + this.api.entries * 0.036
  }

  containerMemMB(): number {
    return this.memoryBaseMB + this.heapUsedMB()
  }

  dockerAttrs(service: string, extra: Record<string, string> = {}) {
    return {
      'com.docker.compose.project': 'tredgate-loan',
      'com.docker.compose.service': service,
      ...extra,
      image: `tredgate-loan-${service}`,
      name: `tredgate-loan-${service}-1`
    }
  }

  // ---- lifecycle ---------------------------------------------------------------------------
  /** docker compose up -d with a new image: kill, die, stop, destroy, create, start */
  recreateApi(t: number, version: '1.1.0' | '1.2.0', persistenceDisabled: boolean) {
    const attrs = this.dockerAttrs('loan-api')
    if (this.api.up) {
      this.tl.dockerEvent(t, 'kill', this.api.containerId, { ...attrs, signal: '15' })
      this.tl.dockerEvent(t + 180, 'die', this.api.containerId, { ...attrs, exitCode: '143' })
      this.tl.dockerEvent(t + 240, 'stop', this.api.containerId, attrs)
    }
    this.tl.dockerEvent(t + 900, 'destroy', this.api.containerId, attrs)
    this.api.up = false
    this.api.containerId = containerId(this.rng)
    this.api.hostname = this.api.containerId.slice(0, 12)
    this.tl.dockerEvent(t + 1400, 'create', this.api.containerId, attrs)
    this.tl.dockerEvent(t + 2100, 'start', this.api.containerId, attrs)
    this.pendingBoot = { at: t + 2100, version, recreate: true, persistenceDisabled }
  }

  /** the host watchdog (cron, every minute) runs `docker compose up -d`, which starts the dead container */
  watchdogRestart(t: number) {
    this.tl.dockerEvent(t, 'start', this.api.containerId, this.dockerAttrs('loan-api'))
    this.pendingBoot = { at: t, version: this.api.version, recreate: false, persistenceDisabled: this.api.persistenceDisabled }
  }

  boot(now: number) {
    const b = this.pendingBoot!
    this.pendingBoot = undefined
    const pid = this.rng.int(25, 41)
    const started = b.at + 4500 + this.rng.int(0, 600)
    if (started > now) {
      this.pendingBoot = b
      return
    }
    for (const [i, line] of DEPRECATION.entries()) this.tl.push(b.at + 2600 + i * 3, 'loan-api', line.replace('PID', String(pid)))
    this.api.pid = pid
    this.api.version = b.version
    this.api.entries = 0
    this.api.heapBase = 18 + this.rng.int(0, 3)
    this.api.persistenceDisabled = b.persistenceDisabled
    if (!b.recreate) this.api.restarts++
    if (b.persistenceDisabled) {
      this.tl.pino(started - 60, 40, pid, this.api.hostname, { reason: 'EACCES /data/loans.json' }, 'persistence disabled')
    }
    const fields: Record<string, unknown> = {}
    if (b.version === '1.2.0') fields.version = '1.2.0'
    Object.assign(fields, { port: 3000, dataFile: '/data/loans.json', logFile: '/app/logs/app.log', servingFrontend: true })
    this.tl.pino(started, 30, pid, this.api.hostname, fields, 'Tredgate Loan API started')
    this.api.startedAt = started
    this.api.up = true
    this.starts.push({ t: started, version: b.version })
  }

  oomKill(t: number) {
    const attrs = this.dockerAttrs('loan-api')
    this.tl.dockerEvent(t, 'oom', this.api.containerId, attrs)
    this.tl.dockerEvent(t + 140 + this.rng.int(0, 90), 'die', this.api.containerId, { ...attrs, exitCode: '137' })
    this.api.up = false
    this.oomKills.push(t)
    // watchdog: next minute boundary plus a few seconds
    const nextMinute = Math.ceil((t + 1) / 60000) * 60000
    this.watchdogRestartAt = nextMinute + 2000 + this.rng.int(0, 6000)
  }
  watchdogRestartAt: number | undefined

  // ---- per request ------------------------------------------------------------------------
  /** gateway + loan-api lines for one API request; returns true when it succeeded */
  apiRequest(t: number, method: string, url: string, client: string, agent: string, onUp: (t: number, id: string) => { status: number; bytes: number }): boolean {
    if (!this.api.up) {
      const upstream = `${UPSTREAM.api}${url}`
      this.tl.nginxError(t + 1, 'error', 'connect() failed (111: Connection refused) while connecting to upstream', client, method, url, upstream, HOST)
      this.tl.access(t + 2, client, method, url, 502, 157, REFERER, agent)
      return false
    }
    const id = reqId(this.rng)
    const latency = 2 + this.rng.int(0, 9)
    const { status, bytes } = onUp(t + 1, id)
    this.tl.access(t + latency + 1, client, method, url, status, bytes, REFERER, agent)
    return status < 500
  }

  completed(t: number, id: string, method: string, url: string, status: number, durationMs: number) {
    this.tl.pino(t + durationMs, 30, this.api.pid, this.api.hostname, { reqId: id, method, url, status, durationMs }, 'request completed')
  }

  calc(t: number) {
    let session = this.sessions.length && this.rng.chance(0.93) ? this.rng.pick(this.sessions) : undefined
    if (!session) {
      session = { name: this.rng.pick(this.dayNames), amount: this.rng.int(10, 2500) * 100, term: this.rng.int(12, 84), rate: this.rng.pick(RATE_BANDS), left: this.rng.int(8, 25) }
      this.sessions.push(session)
    }
    // the officer keeps adjusting the figures while the preview updates
    if (this.rng.chance(0.4)) session.amount = Math.max(1000, session.amount + this.rng.pick([-10000, -5000, -1000, 1000, 5000, 10000]))
    if (this.rng.chance(0.25)) session.term = Math.max(6, Math.min(84, session.term + this.rng.pick([-12, -6, 6, 12])))
    if (this.rng.chance(0.1)) session.rate = this.rng.pick(RATE_BANDS)
    session.left--
    if (session.left <= 0) this.sessions.splice(this.sessions.indexOf(session), 1)
    const body = { applicantName: session.name, amount: session.amount, termMonths: session.term, interestRate: session.rate, requestedAt: iso(t) }
    const url = '/api/installments/calculate'
    const client = officerIp(this.rng)
    const agent = this.rng.pick(USER_AGENTS)
    this.apiRequest(t, 'POST', url, client, agent, (ts, id) => {
      if (this.api.version === '1.1.0') {
        // 1.1.0 has no calculator: the old UI never calls it, this is a stale tab
        this.tl.pino(ts, 40, this.api.pid, this.api.hostname, { reqId: id, status: 404, reason: `Route POST ${url} not found` }, 'request rejected')
        this.completed(ts, id, 'POST', url, 404, 1)
        return { status: 404, bytes: 68 }
      }
      this.tl.pino(ts, 30, this.api.pid, this.api.hostname, { reqId: id, request: body }, 'installment cache miss')
      this.api.entries++
      const duration = 3 + this.rng.int(0, 8) + (this.heapUsedMB() > 55 ? this.rng.int(10, 120) : 0)
      this.completed(ts, id, 'POST', url, 200, duration)
      if (this.containerMemMB() >= this.memoryLimitMB) this.oomKill(ts + duration + 150)
      return { status: 200, bytes: 2100 + body.termMonths * 118 }
    })
  }

  list(t: number) {
    const client = officerIp(this.rng)
    this.apiRequest(t, 'GET', '/api/loans', client, this.rng.pick(USER_AGENTS), (ts, id) => {
      const count = this.api.persistenceDisabled ? this.memoryLoanCount : this.loanCount
      const duration = 1 + this.rng.int(0, 3)
      this.completed(ts, id, 'GET', '/api/loans', 200, duration)
      return { status: 200, bytes: 1250 + (count - 6) * 212 }
    })
  }
  memoryLoanCount = 6

  health(t: number) {
    this.apiRequest(t, 'GET', '/api/health', DOCKER_HOST_IP, 'curl/8.5.0', (ts, id) => {
      this.completed(ts, id, 'GET', '/api/health', 200, 1)
      return { status: 200, bytes: this.api.version === '1.2.0' ? 52 : 34 }
    })
  }

  quote(t: number) {
    const paid = this.rng.int(0, 23)
    const url = `/api/loans/ln-1001/settlement-quote?paid=${paid}&date=2026-10-05`
    this.apiRequest(t, 'GET', url, officerIp(this.rng), this.rng.pick(USER_AGENTS), (ts, id) => {
      this.tl.pino(ts, 30, this.api.pid, this.api.hostname, { reqId: id, loanId: 'ln-1001', paid, total: 27000 - paid * 1125 }, 'settlement quoted')
      this.completed(ts, id, 'GET', url, 200, 2)
      return { status: 200, bytes: 143 }
    })
  }

  create(t: number, fixed?: { id: string; amount: number; term: number }) {
    const amount = fixed?.amount ?? this.rng.int(10, 1500) * 100
    const term = fixed?.term ?? this.rng.int(6, 84)
    const bad = !fixed && this.rng.chance(0.08)
    this.apiRequest(t, 'POST', '/api/loans', officerIp(this.rng), this.rng.pick(USER_AGENTS), (ts, id) => {
      if (bad) {
        this.tl.pino(ts, 40, this.api.pid, this.api.hostname, { reqId: id, status: 400, reason: 'Interest rate must be between 0 and 1 (e.g. 0.08 for 8%)' }, 'request rejected')
        this.completed(ts, id, 'POST', '/api/loans', 400, 2)
        return { status: 400, bytes: 70 }
      }
      const newId = fixed?.id ?? loanId(this.rng, ts)
      this.tl.pino(ts, 30, this.api.pid, this.api.hostname, { reqId: id, loanId: newId, amount, termMonths: term }, 'loan created')
      this.completed(ts, id, 'POST', '/api/loans', 201, 4)
      this.pending.push(newId)
      if (this.api.persistenceDisabled) this.memoryLoanCount++
      else this.loanCount++
      return { status: 201, bytes: 212 }
    })
  }

  decide(t: number, fixedId?: string, auto = false) {
    const id = fixedId ?? (this.pending.length ? this.rng.pick(this.pending) : undefined)
    if (!id) return
    const method = auto ? 'POST' : 'PATCH'
    const url = auto ? `/api/loans/${id}/auto-decide` : `/api/loans/${id}/status`
    const decision = auto ? 'approved' : this.rng.chance(0.8) ? 'approved' : 'rejected'
    this.apiRequest(t, method, url, officerIp(this.rng), this.rng.pick(USER_AGENTS), (ts, rid) => {
      if (this.decided.has(id)) {
        this.tl.pino(ts, 40, this.api.pid, this.api.hostname, { reqId: rid, status: 409, reason: `Loan with id ${id} has already been decided (approved)` }, 'request rejected')
        this.completed(ts, rid, method, url, 409, 2)
        return { status: 409, bytes: 72 }
      }
      if (this.api.persistenceDisabled) {
        const message = "EACCES: permission denied, open '/data/audit.log'"
        this.tl.pino(ts + 2, 50, this.api.pid, this.api.hostname, { reqId: rid, err: pino500(message, '41:15') }, 'request failed with an unexpected error')
        this.completed(ts, rid, method, url, 500, 4)
        return { status: 500, bytes: 68 }
      }
      this.tl.pino(ts, 30, this.api.pid, this.api.hostname, { reqId: rid, loanId: id, status: decision }, auto ? 'loan auto-decided' : 'loan status updated')
      if (this.api.version === '1.2.0') this.tl.pino(ts, 30, this.api.pid, this.api.hostname, { reqId: rid, loanId: id, decision }, 'decision audited')
      this.completed(ts, rid, method, url, 200, 3)
      this.pending.splice(this.pending.indexOf(id), 1)
      this.decided.add(id)
      return { status: 200, bytes: 212 }
    })
  }

  docsSearch(t: number) {
    const q = this.rng.pick(SEARCH_QUESTIONS)
    const k = this.rng.pick([3, 5, 5, 5, 8])
    const url = `/docs/search?q=${encodeURIComponent(q).replace(/%20/g, '+')}&k=${k}`
    const tokens = this.rng.int(120, 380) * k
    this.tl.docs(t + 3, `[rag] search "${q}" k=${k} -> ${k} chunks, ${tokens} tokens`)
    this.tl.access(t + 5 + this.rng.int(0, 6), officerIp(this.rng), 'GET', url, 200, 2400 + tokens * 4, REFERER, this.rng.pick(USER_AGENTS))
  }

  /** the handbook sync cron reindexes docs-search; it takes longer than the gateway waits */
  reindex(t: number) {
    const url = `/docs/reindex?token=${TOKEN}`
    this.tl.nginxError(t + 5000, 'error', 'upstream timed out (110: Connection timed out) while reading response header from upstream', DOCKER_HOST_IP, 'POST', url, `${UPSTREAM.docs}/reindex?token=${TOKEN}`, 'localhost:8080')
    this.tl.access(t + 5001, DOCKER_HOST_IP, 'POST', url, 504, 167, '-', 'curl/8.5.0')
    this.tl.docs(t + 6300 + this.rng.int(0, 1500), '[rag] index rebuilt on request: 360 chunks from 34 files')
  }

  // ---- time loop ---------------------------------------------------------------------------
  run(start: number, end: number, rates: (t: number) => Rates, scripted: (t: number) => void) {
    let nextMetrics = 0
    let lastMinute = -1
    for (let t = start; t < end; t += 1000) {
      if (this.pendingBoot) this.boot(t)
      if (this.watchdogRestartAt !== undefined && t >= this.watchdogRestartAt) {
        this.watchdogRestart(this.watchdogRestartAt)
        this.watchdogRestartAt = undefined
      }
      scripted(t)
      const r = rates(t)
      const second = (rate: number, fn: (ts: number) => void) => {
        const count = poisson(this.rng, rate)
        for (let i = 0; i < count; i++) fn(t + this.rng.int(0, 999))
      }
      second(r.calc, ts => this.calc(ts))
      second(r.list, ts => this.list(ts))
      second(r.docs, ts => this.docsSearch(ts))
      second(r.quote, ts => this.quote(ts))
      second(r.create, ts => this.create(ts))
      second(r.decide, ts => this.decide(ts))
      if (r.health > 0 && t % Math.round(1000 / r.health) === 0) this.health(t + 400)
      this.cpuLoad = this.cpuLoad * 0.9 + (r.calc + r.list + r.quote) * 0.1

      // process metrics every 60 s of uptime (1.2.0 only)
      if (this.api.up && this.api.version === '1.2.0') {
        if (nextMetrics < this.api.startedAt) nextMetrics = this.api.startedAt + 60000
        while (nextMetrics <= t && this.api.up) {
          const heap = Math.round(this.heapUsedMB() + this.rng.int(-2, 2))
          this.tl.pino(nextMetrics, 30, this.api.pid, this.api.hostname, { heapUsedMB: heap, rssMB: heap + 74 + this.rng.int(0, 6), cacheEntries: this.api.entries, uptimeSeconds: Math.round((nextMetrics - this.api.startedAt) / 1000) }, 'process metrics')
          nextMetrics += 60000
        }
      }

      // metrics.csv once per minute
      const minute = Math.floor(t / 60000)
      if (minute !== lastMinute) {
        lastMinute = minute
        const stamp = iso(minute * 60000).slice(0, 19) + 'Z'
        const heap = this.heapUsedMB()
        const apiMem = this.api.up ? Math.round((this.api.version === '1.2.0' ? this.memoryBaseMB + heap : 148) + this.rng.int(-3, 3)) : 0
        const gcPressure = this.api.up && this.api.version === '1.2.0' && heap > 50 ? this.rng.int(35, 60) : 0
        const apiCpu = this.api.up ? Math.min(98, Math.round(3 + this.cpuLoad * 5 + gcPressure + this.rng.int(0, 4))) : 0
        this.metrics.push(`${stamp},gateway,${(1 + this.cpuLoad * 0.6 + this.rng.next()).toFixed(1)},${7 + this.rng.int(0, 2)},0`)
        this.metrics.push(`${stamp},loan-api,${apiCpu.toFixed(1)},${apiMem},${this.api.restarts}`)
        this.metrics.push(`${stamp},docs-search,${(1.5 + this.rng.next() * 2).toFixed(1)},${138 + this.rng.int(0, 9)},0`)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// INC-20261005-01: restart loop after the 1.2.0 deployment (Monday 2026-10-05)
// ---------------------------------------------------------------------------------------------
function ramp(t: number, from: number, to: number, a: number, b: number): number {
  if (t <= from) return a
  if (t >= to) return b
  return a + ((b - a) * (t - from)) / (to - from)
}

function generateInc1(outDir: string) {
  const D = '2026-10-05'
  const START = utc(D, '06:00'), END = utc(D, '09:30')
  const DEPLOY = utc(D, '06:30:00'), ROLLBACK = utc(D, '08:20:00')
  const sim = new DaySim(20261005, 110, 256, 190)
  const reindexAt = ['06:05:10', '06:50:10', '07:26:10', '08:11:10', '08:56:10'].map(c => utc(D, c))

  // Branch CZ-PRG-01 opens at 09:00 CEST (07:00Z); the morning queue peaks from about 09:20 CEST
  const rates = (t: number): Rates => {
    const open = utc(D, '07:00'), peak = utc(D, '07:20')
    if (t < DEPLOY) return { calc: 0.03, list: 0.08, docs: 0.03, health: 0.1, quote: 0.01, create: 0.003, decide: 0.003 }
    if (t < utc(D, '06:45')) return { calc: 0.12, list: 0.2, docs: 0.08, health: 0.1, quote: 0.03, create: 0.005, decide: 0.005 }
    if (t < open) return { calc: 0.3, list: 0.4, docs: 0.2, health: 0.1, quote: 0.06, create: 0.01, decide: 0.01 }
    if (t < ROLLBACK) {
      const f = ramp(t, open, peak, 0, 1)
      return { calc: 0.4 + f * 2.6, list: 0.6 + f * 0.9, docs: 0.3 + f * 0.5, health: 0.1, quote: 0.08 + f * 0.17, create: 0.01 + f * 0.02, decide: 0.01 + f * 0.02 }
    }
    return { calc: 0.5, list: 0.3, docs: 0.15, health: 0.1, quote: 0.05, create: 0.01, decide: 0.01 }
  }

  let deployed = false, rolledBack = false
  const docsAttrs = sim.dockerAttrs('docs-search')
  const docsId = containerId(sim.rng)
  sim.run(START, END, rates, t => {
    if (!deployed && t >= DEPLOY) {
      deployed = true
      // docs-search is rebuilt as well
      sim.tl.dockerEvent(t - 2600, 'kill', docsId, { ...docsAttrs, signal: '15' })
      sim.tl.dockerEvent(t - 2400, 'die', docsId, { ...docsAttrs, exitCode: '143' })
      sim.tl.dockerEvent(t - 2300, 'stop', docsId, docsAttrs)
      sim.tl.dockerEvent(t - 1500, 'destroy', docsId, docsAttrs)
      sim.tl.dockerEvent(t - 900, 'create', containerId(sim.rng), docsAttrs)
      sim.tl.dockerEvent(t - 300, 'start', containerId(sim.rng), docsAttrs)
      sim.tl.docs(t + 1400, '[rag] documentation search API listening on http://localhost:3001 (docs: /app/docs/handbook)')
      sim.recreateApi(t, '1.2.0', false)
    }
    if (!rolledBack && t >= ROLLBACK) {
      rolledBack = true
      sim.recreateApi(t, '1.1.0', false)
    }
    for (const at of reindexAt) if (t === at) sim.reindex(t)
  })

  const text = sim.tl.render()
  const dir = path.join(outDir, 'INC-20261005-01', 'logs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'combined.log'), text)
  writeFileSync(path.join(dir, 'metrics.csv'), sim.metrics.join('\n') + '\n')
  report('INC-20261005-01', text, sim, sim.oomKills[0]!, sim.starts.find(s => s.t > ROLLBACK)!.t)
}

// ---------------------------------------------------------------------------------------------
// INC-20261007-01: lost applications after the hardened redeploy (Wednesday 2026-10-07)
// ---------------------------------------------------------------------------------------------
function generateInc2(outDir: string) {
  const D = '2026-10-07'
  const START = utc(D, '10:30'), END = utc(D, '15:30')
  const DEPLOY = utc(D, '11:00:00'), RESTART = utc(D, '13:42:00'), FIX = utc(D, '14:40:00')
  const sim = new DaySim(20261007, 40, 512, 196)
  const created = [
    { at: utc(D, '11:10:24'), id: 'mv9c2k1lzq8r4ta', amount: 18000, term: 24 },
    { at: utc(D, '12:05:51'), id: 'mv9dt0f7hrx3n2w', amount: 42000, term: 48 },
    { at: utc(D, '13:35:08'), id: 'mv9g8w3bq1pm7ye', amount: 9500, term: 12 }
  ]
  const approvals = [
    { at: utc(D, '11:25:40'), id: 'mv9c2k1lzq8r4ta' },
    { at: utc(D, '12:50:17'), id: 'mv9dt0f7hrx3n2w' }
  ]
  const reentry = [
    { at: utc(D, '14:43:12'), id: 'mv9kq4d2xz7n1rb', amount: 18000, term: 24 },
    { at: utc(D, '14:45:03'), id: 'mv9kr7m8vt3c5la', amount: 42000, term: 48 },
    { at: utc(D, '14:47:39'), id: 'mv9ksx1h9fq2w6e', amount: 9500, term: 12 }
  ]
  const reapprovals = [
    { at: utc(D, '14:50:22'), id: 'mv9kq4d2xz7n1rb' },
    { at: utc(D, '14:52:08'), id: 'mv9kr7m8vt3c5la' }
  ]
  const evaChecks = ['13:50:12', '13:50:41', '13:51:05'].map(c => utc(D, c))
  const reindexAt = ['10:35:10', '11:20:10', '12:05:10', '12:50:10', '13:35:10', '14:20:10', '15:05:10'].map(c => utc(D, c))

  const rates = (): Rates => ({ calc: 0.07, list: 0.09, docs: 0.035, health: 1 / 30, quote: 0.012, create: 0, decide: 0 })

  let deployed = false, restarted = false, fixed = false
  sim.run(START, END, rates, t => {
    if (!deployed && t >= DEPLOY) {
      deployed = true
      sim.recreateApi(t, '1.2.0', true)
    }
    if (!restarted && t >= RESTART) {
      restarted = true
      sim.memoryLoanCount = 6
      sim.recreateApi(t, '1.2.0', true)
    }
    if (!fixed && t >= FIX) {
      fixed = true
      sim.recreateApi(t, '1.2.0', false)
    }
    for (const c of created) if (t === c.at) sim.create(t + 300, c)
    for (const a of approvals) if (t === a.at) sim.decide(t + 300, a.id)
    for (const c of reentry) if (t === c.at) sim.create(t + 300, c)
    for (const a of reapprovals) if (t === a.at) sim.decide(t + 300, a.id)
    for (const at of evaChecks) if (t === at) sim.list(t + 200)
    for (const at of reindexAt) if (t === at) sim.reindex(t)
  })

  const text = sim.tl.render()
  const dir = path.join(outDir, 'INC-20261007-01', 'logs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'combined.log'), text)
  writeFileSync(path.join(dir, 'metrics.csv'), sim.metrics.join('\n') + '\n')
  report('INC-20261007-01', text, sim, DEPLOY, END)
}

// ---------------------------------------------------------------------------------------------
function report(id: string, text: string, sim: DaySim, windowStart: number, windowEnd: number) {
  const lines = text.split('\n').filter(Boolean)
  const names = new Set<string>()
  const namesInWindow = new Set<string>()
  let total = 0, failed = 0, timeouts = 0
  const accessTime = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) \+0000\] "(\S+) (\S+) [^"]*" (\d{3})/
  const months: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
  for (const line of lines) {
    const nameMatch = line.match(/"applicantName":"([^"]+)"/)
    if (nameMatch && line.includes('installment cache miss')) {
      names.add(nameMatch[1]!)
      const t = Date.parse(line.match(/"time":"([^"]+)"/)![1]!)
      if (t >= windowStart && t < windowEnd) namesInWindow.add(nameMatch[1]!)
    }
    const a = line.match(accessTime)
    if (a && line.startsWith('gateway')) {
      const t = Date.UTC(Number(a[3]), months[a[2]!]!, Number(a[1]), Number(a[4]), Number(a[5]), Number(a[6]))
      if (t >= windowStart && t < windowEnd) {
        total++
        if (a[9] === '502') failed++
        if (a[9] === '504') timeouts++
      }
    }
  }
  const bytes = Buffer.byteLength(text)
  console.log(`\n${id}`)
  console.log(`  lines: ${lines.length}, size: ${(bytes / 1048576).toFixed(1)} MB`)
  console.log(`  window ${iso(windowStart)} .. ${iso(windowEnd)} (${Math.round((windowEnd - windowStart) / 60000)} min)`)
  console.log(`  gateway requests in window: ${total}, 502: ${failed} (${((failed / Math.max(total, 1)) * 100).toFixed(1)} %), 504 reindex timeouts: ${timeouts}`)
  console.log(`  OOM kills: ${sim.oomKills.length} at ${sim.oomKills.map(t => iso(t).slice(11, 19)).join(' ')}`)
  console.log(`  'Tredgate Loan API started' lines: ${sim.starts.length} (${sim.starts.map(s => `${iso(s.t).slice(11, 19)} ${s.version}`).join(', ')})`)
  console.log(`  distinct applicant names in 'installment cache miss': ${names.size} whole log, ${namesInWindow.size} in window`)
}

const out = path.resolve(values.out)
if (!values.only || values.only === 'INC-20261005-01') generateInc1(out)
if (!values.only || values.only === 'INC-20261007-01') generateInc2(out)
