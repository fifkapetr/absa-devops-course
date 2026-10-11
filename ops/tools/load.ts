import { parseCli } from './lib/cli'
import { fakeCalculation, SEARCH_QUESTIONS } from './lib/fakeData'
import { createRng } from './lib/random'

/**
 * npm run ops:load
 *
 * Traffic generator for the loan API and the handbook search. Mix: 60 % installment
 * calculations with a fresh requestedAt and a random fake applicant, 25 % loan list and
 * settlement quote, 15 % handbook search. Prints a live line every 10 s and a summary;
 * exit code 1 when the error rate is above 1 %, p95 above 500 ms, or the API restarted
 * during the run (its uptimeSeconds went backwards).
 */
const { values } = parseCli(
  'npm run ops:load',
  'Generates realistic traffic against the loan API and the handbook search.',
  {
    target: { type: 'string', default: 'http://localhost:3000', description: 'Loan API base URL' },
    docs: { type: 'string', default: 'http://localhost:3001', description: 'Handbook search base URL' },
    duration: { type: 'string', default: '180', description: 'Test duration in seconds' },
    rps: { type: 'string', default: '30', description: 'Requests per second' },
    seed: { type: 'string', default: '42', description: 'Seed for the fake applicants and amounts' }
  }
)

const durationMs = Number(values.duration) * 1000
const rps = Number(values.rps)
const rng = createRng(Number(values.seed))
const tickMs = 100
const perTick = rps / (1000 / tickMs)

const latencies: number[] = []
let total = 0
let errors = 0
let inFlight = 0
let docsEnabled = true
let restarts = 0
let lastUptime = -1
const statusCounts = new Map<string, number>()
const errorSamples = new Map<string, number>()

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

/** A process that restarted reports a smaller uptime than before */
async function checkUptime(): Promise<void> {
  try {
    const response = await fetch(`${values.target}/api/health`, { signal: AbortSignal.timeout(3000) })
    const body = (await response.json()) as { uptimeSeconds?: number }
    const uptime = body.uptimeSeconds ?? -1
    if (lastUptime >= 0 && uptime < lastUptime) restarts++
    lastUptime = uptime
  } catch {
    // the API is down right now; the failed requests already count as errors
  }
}

async function send(url: string, init?: RequestInit): Promise<void> {
  const started = performance.now()
  inFlight++
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
    await response.arrayBuffer()
    record(started, response.status, response.ok ? undefined : `HTTP ${response.status}`)
  } catch (err) {
    record(started, 0, err instanceof Error ? err.name : String(err))
  } finally {
    inFlight--
  }
}

function record(started: number, status: number, error?: string) {
  total++
  latencies.push(performance.now() - started)
  const key = status === 0 ? 'ERR' : String(status)
  statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1)
  if (error) {
    errors++
    errorSamples.set(error, (errorSamples.get(error) ?? 0) + 1)
  }
}

function oneRequest(): Promise<void> {
  const roll = rng.next()
  if (roll < 0.6) {
    const body = { ...fakeCalculation(rng), requestedAt: new Date().toISOString() }
    return send(`${values.target}/api/installments/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }
  if (roll < 0.85 || !docsEnabled) {
    // 25 %: list, or the settlement quote of an approved seed loan (the closest thing to a detail call)
    return rng.chance(0.7)
      ? send(`${values.target}/api/loans`)
      : send(`${values.target}/api/loans/ln-1001/settlement-quote?paid=${rng.int(0, 23)}&date=2026-10-05`)
  }
  const q = encodeURIComponent(rng.pick(SEARCH_QUESTIONS))
  return send(`${values.docs}/search?q=${q}&k=3`)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

function summary(final: boolean) {
  const sorted = [...latencies].sort((a, b) => a - b)
  const rate = total ? (errors / total) * 100 : 0
  const line =
    `${final ? 'summary' : 'live'}  total=${total} errors=${errors} errorRate=${rate.toFixed(2)}%` +
    ` p50=${percentile(sorted, 50).toFixed(0)}ms p95=${percentile(sorted, 95).toFixed(0)}ms p99=${percentile(sorted, 99).toFixed(0)}ms` +
    ` apiRestarts=${restarts}` +
    (final ? '' : ` inFlight=${inFlight}`)
  console.log(`[${new Date().toISOString()}] ${line}`)
  return { rate, p95: percentile(sorted, 95) }
}

async function main() {
  if (!(await probe(`${values.target}/api/health`))) {
    console.error(`ops:load: ${values.target}/api/health is not reachable. Start the API first (npm run ops:incident or npm start).`)
    process.exit(2)
  }
  if (!(await probe(`${values.docs}/health`))) {
    console.warn(`ops:load: ${values.docs} is not reachable; handbook search traffic is replaced by loan reads.`)
    docsEnabled = false
  }
  console.log(`ops:load: ${rps} req/s for ${values.duration} s against ${values.target}${docsEnabled ? ` and ${values.docs}` : ''} (seed ${values.seed})`)

  const startedAt = Date.now()
  let carry = 0
  const ticker = setInterval(() => {
    carry += perTick
    while (carry >= 1) {
      carry--
      void oneRequest()
    }
  }, tickMs)
  await checkUptime()
  const reporter = setInterval(() => {
    void checkUptime().then(() => summary(false))
  }, 10_000)

  await new Promise(resolve => setTimeout(resolve, durationMs))
  clearInterval(ticker)
  clearInterval(reporter)
  // let the in-flight requests finish
  const deadline = Date.now() + 10_000
  while (inFlight > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))

  await checkUptime()
  const { rate, p95 } = summary(true)
  console.log(`statuses: ${[...statusCounts.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (errorSamples.size) console.log(`errors:   ${[...errorSamples.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
  console.log(`elapsed:  ${Math.round((Date.now() - startedAt) / 1000)} s`)
  const reasons = [rate > 1 && 'error rate > 1 %', p95 > 500 && 'p95 > 500 ms', restarts > 0 && `API restarted ${restarts} time(s) during the run`].filter(Boolean)
  console.log(reasons.length ? `RESULT: FAIL (${reasons.join('; ')})` : 'RESULT: PASS')
  const failed = reasons.length > 0
  process.exit(failed ? 1 : 0)
}

void main()
