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
 *
 * Usage (start the API first, e.g. `npx tsx ops/tools/incident.ts` in another terminal):
 *   npx tsx ops/tools/load.ts                         defaults: 30 req/s for 180 s
 *   npx tsx ops/tools/load.ts --duration 60           a shorter run
 *   npx tsx ops/tools/load.ts --rps 5 --duration 30   gentle smoke test
 *   npm run ops:load -- --duration 60                 the same through npm
 *
 * Reading the output:
 *   live     total=… errors=… errorRate=…% p50=…ms p95=…ms p99=…ms apiRestarts=… inFlight=…
 *   summary  the same numbers for the whole run, followed by:
 *   statuses: 200=… 400=… ERR=…        HTTP status counts; ERR = no response (refused, timed out)
 *   errors:   HTTP <status>=… <ErrorName>=…  what the failed requests ran into (only when there were any)
 *   RESULT: PASS  or  RESULT: FAIL (<reasons>)
 *
 * p50/p95/p99 are latency percentiles: p95=200ms means 95 % of requests answered within 200 ms.
 * inFlight is the number of requests sent but not yet answered; when it keeps growing, the
 * server is slower than the traffic arriving.
 *
 * The same --seed gives the same sequence of request types and fake applicants, so two runs
 * (before and after a change) send comparable traffic. Timing on your machine still varies.
 *
 * Exit codes: 0 PASS, 1 FAIL, 2 the API is not reachable at the start.
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
// Requests are started in small batches every 100 ms instead of all at once each second,
// which spreads the load evenly. perTick can be a fraction (30 req/s → 3 per tick, 5 req/s → 0.5).
const tickMs = 100
const perTick = rps / (1000 / tickMs)

// Measurements collected during the run.
const latencies: number[] = []                    // response time of every request in ms
let total = 0                                      // requests completed (answered or failed)
let errors = 0                                     // of those: non-2xx answers and network errors
let inFlight = 0                                   // sent, not yet completed
let docsEnabled = true                             // false when the handbook search is not running
let restarts = 0                                   // API restarts detected through /api/health
let lastUptime = -1                                // uptimeSeconds seen at the previous health check
const statusCounts = new Map<string, number>()     // '200' → 1234, 'ERR' → 5
const errorSamples = new Map<string, number>()     // 'HTTP 404' → 3, 'TimeoutError' → 2

/**
 * Is a service up? A single GET with a 3 s timeout; used once before the run starts.
 *
 * @param url a health endpoint
 * @returns true for a 2xx answer, false for an error status, a timeout or no connection
 */
async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Detect API restarts from the outside. /api/health returns how long the process has been
 * running; when that number is smaller than at the last check, the process was restarted
 * in between (by the supervisor, Docker or anything else).
 */
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

/**
 * Send one HTTP request and record its latency and outcome. Never throws: network errors
 * and timeouts are recorded as errors, so one failed request does not stop the run.
 *
 * @param url  full URL to call
 * @param init fetch options (method, headers, body) for POST requests
 */
async function send(url: string, init?: RequestInit): Promise<void> {
  const started = performance.now()
  inFlight++
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
    // Read the whole body: latency should include the download, not just the first byte.
    await response.arrayBuffer()
    record(started, response.status, response.ok ? undefined : `HTTP ${response.status}`)
  } catch (err) {
    // No HTTP answer at all: status 0, and the error name (TimeoutError, TypeError for "connection refused", ...).
    record(started, 0, err instanceof Error ? err.name : String(err))
  } finally {
    inFlight--
  }
}

/**
 * Add one completed request to the statistics.
 *
 * @param started the `performance.now()` value when the request was sent
 * @param status  HTTP status, or 0 when there was no response
 * @param error   a short label when the request failed; undefined on success
 */
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

/**
 * Pick one request type at random according to the traffic mix and send it.
 * One random number between 0 and 1 decides the type: below 0.6 → calculation (60 %),
 * below 0.85 → loan read (25 %), otherwise → handbook search (15 %).
 */
function oneRequest(): Promise<void> {
  const roll = rng.next()
  if (roll < 0.6) {
    // 60 %: an installment calculation for a random fake applicant, stamped with the current time.
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
  // 15 %: a typical officer question to the handbook search.
  const q = encodeURIComponent(rng.pick(SEARCH_QUESTIONS))
  return send(`${values.docs}/search?q=${q}&k=3`)
}

/**
 * The value below which p percent of the measurements fall (nearest-rank method).
 *
 * @param sorted latencies sorted from fastest to slowest
 * @param p      percentile, e.g. 95
 * @returns the latency in ms, or 0 when nothing was measured yet
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

/**
 * Print one status line with the numbers so far.
 *
 * @param final true for the end-of-run summary, false for the live line every 10 s
 * @returns the error rate in % and the p95 latency in ms, used for the PASS/FAIL decision
 */
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

/**
 * The run: check the targets, send traffic for --duration seconds, wait for the last
 * answers, print the summary and exit with PASS (0) or FAIL (1).
 */
async function main() {
  // 1. Pre-flight: without the API there is nothing to test; without the handbook search we carry on.
  if (!(await probe(`${values.target}/api/health`))) {
    console.error(`ops:load: ${values.target}/api/health is not reachable. Start the API first (npm run ops:incident or npm start).`)
    process.exit(2)
  }
  if (!(await probe(`${values.docs}/health`))) {
    console.warn(`ops:load: ${values.docs} is not reachable; handbook search traffic is replaced by loan reads.`)
    docsEnabled = false
  }
  console.log(`ops:load: ${rps} req/s for ${values.duration} s against ${values.target}${docsEnabled ? ` and ${values.docs}` : ''} (seed ${values.seed})`)

  // 2. Traffic: every tick adds perTick to `carry` and sends one request per whole unit.
  //    The fraction is kept for the next tick, so 0.5 per tick sends one request every second tick.
  //    Requests are not awaited (`void`): new ones go out on time even when old ones are still waiting
  //    for an answer, like real users who do not wait for each other.
  const startedAt = Date.now()
  let carry = 0
  const ticker = setInterval(() => {
    carry += perTick
    while (carry >= 1) {
      carry--
      void oneRequest()
    }
  }, tickMs)
  // Remember the API's uptime at the start, then check it and print a live line every 10 s.
  await checkUptime()
  const reporter = setInterval(() => {
    void checkUptime().then(() => summary(false))
  }, 10_000)

  // 3. Stop sending after --duration seconds.
  await new Promise(resolve => setTimeout(resolve, durationMs))
  clearInterval(ticker)
  clearInterval(reporter)
  // let the in-flight requests finish
  const deadline = Date.now() + 10_000
  while (inFlight > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))

  // 4. Results and the PASS/FAIL decision.
  await checkUptime()
  const { rate, p95 } = summary(true)
  console.log(`statuses: ${[...statusCounts.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (errorSamples.size) console.log(`errors:   ${[...errorSamples.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
  console.log(`elapsed:  ${Math.round((Date.now() - startedAt) / 1000)} s`)
  // Each threshold that is crossed adds a reason; `.filter(Boolean)` drops the `false` entries.
  const reasons = [rate > 1 && 'error rate > 1 %', p95 > 500 && 'p95 > 500 ms', restarts > 0 && `API restarted ${restarts} time(s) during the run`].filter(Boolean)
  console.log(reasons.length ? `RESULT: FAIL (${reasons.join('; ')})` : 'RESULT: PASS')
  const failed = reasons.length > 0
  process.exit(failed ? 1 : 0)
}

void main()
