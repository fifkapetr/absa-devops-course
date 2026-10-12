import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { parseCli, resolveInput } from './lib/cli'

/**
 * npm run ops:incident
 *
 * Runs the loan API the way the container pilot does: under a supervisor that restarts it
 * when it exits, with a small heap and frequent `process metrics` lines. The handbook search
 * (docs-search, port 3001) is started alongside so `npm run ops:load` has both targets.
 * Nothing is built; the API serves the existing dist/ if there is one.
 *
 * A supervisor is a parent process that watches a child process and starts it again when it
 * stops, which is what Docker's `restart:` policy or a systemd unit does on a real server. Here it is a
 * few lines of Node.js, so you can reproduce the pilot's runtime on your laptop without Docker.
 *
 * Usage (two terminals):
 *   terminal 1:  npx tsx ops/tools/incident.ts                 start API + handbook search, leave it running
 *   terminal 2:  npx tsx ops/tools/load.ts                     send traffic at it
 *   Ctrl+C in terminal 1 stops the supervisor and both children.
 *
 * Options worth knowing:
 *   --heap 96             memory limit of the API process in MB (V8's --max-old-space-size)
 *   --port 3100           run on another port, e.g. when `npm run dev` already uses 3000
 *                         (then point the load generator at it: `load.ts --target http://localhost:3100`)
 *   --data-file <path>    use a copy of the data instead of server/data/loans.json
 *   --log-file <path>     where the API and the supervisor write their JSON log lines
 *   --no-docs             start only the API
 *
 * What you see: the API's own output, plus the supervisor's JSON lines, e.g.
 *   {"level":50,"time":"…","code":…,"signal":…,"restarts":…,"msg":"supervisor: loan-api exited"}
 * The same lines are appended to the log file, so `npx tsx ops/tools/logs.ts --file logs/app.log`
 * can read them afterwards.
 */
const { values } = parseCli(
  'npm run ops:incident',
  'Starts loan-api under a restarting supervisor with a limited heap, plus docs-search.',
  {
    heap: { type: 'string', default: '96', description: 'V8 old-space limit for loan-api in MB (--max-old-space-size)' },
    'metrics-interval': { type: 'string', default: '5000', description: 'METRICS_INTERVAL_MS for loan-api' },
    'no-docs': { type: 'boolean', default: false, description: 'Do not start docs-search on port 3001' },
    port: { type: 'string', description: 'PORT of loan-api (default 3000, or the PORT environment variable)' },
    'data-file': { type: 'string', description: 'DATA_FILE of loan-api (default server/data/loans.json)' },
    'log-file': { type: 'string', description: 'LOG_FILE of loan-api and the supervisor (default logs/app.log)' }
  }
)

const root = path.resolve(import.meta.dirname, '..', '..')
// Log file precedence: --log-file, then the LOG_FILE environment variable, then logs/app.log.
const logFile = values['log-file'] ? resolveInput(values['log-file']) : (process.env.LOG_FILE ?? path.join(root, 'logs', 'app.log'))
// The flags are handed to the API as environment variables (REF-030), the same way compose.yaml configures the container.
const childEnv: Record<string, string> = {}
if (values.port) childEnv.PORT = values.port
if (values['data-file']) childEnv.DATA_FILE = resolveInput(values['data-file'])
mkdirSync(path.dirname(logFile), { recursive: true })

// Supervisor state, shared by the start/stop functions below.
let restarts = 0          // how many times loan-api has been started again after exiting
let stopping = false      // set on Ctrl+C so the exit handlers do not restart anything
let api: ChildProcess | undefined
let docs: ChildProcess | undefined

/**
 * Write one log line in the same pino JSON format the API uses, so the log reader can filter
 * supervisor lines and API lines together (e.g. `--level error`).
 *
 * @param level  pino level: 30 info, 40 warn, 50 error
 * @param msg    the message; supervisor lines start with "supervisor:"
 * @param fields extra JSON fields, e.g. the exit code
 */
function supervisorLog(level: number, msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), ...fields, msg })
  console.log(line)
  try {
    appendFileSync(logFile, line + '\n')
  } catch {
    // the log folder may be unwritable; the terminal still has the line
  }
}

/**
 * Start loan-api as a child process and restart it one second after it exits.
 * The child is the same `node --import tsx server/index.ts` you would run by hand, plus the heap limit.
 * `stdio: 'inherit'` lets the API print straight into this terminal.
 */
function startApi() {
  api = spawn(process.execPath, [`--max-old-space-size=${values.heap}`, '--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...childEnv, METRICS_INTERVAL_MS: values['metrics-interval'], LOG_FILE: logFile }
  })
  // `code` is the exit code (null when killed); `signal` names the signal that killed it (null when it exited itself).
  api.on('exit', (code, signal) => {
    if (stopping) return
    supervisorLog(50, 'supervisor: loan-api exited', { code, signal, restarts })
    restarts++
    setTimeout(startApi, 1000)
  })
}

/**
 * Start the handbook search (rag/server.ts) on port 3001. Unlike the API it is not restarted:
 * if it exits, the supervisor logs that once and `ops:load` reports the failed search requests.
 */
function startDocs() {
  docs = spawn(process.execPath, ['--import', 'tsx', 'rag/server.ts'], { cwd: root, stdio: 'inherit', env: process.env })
  docs.on('exit', (code, signal) => {
    if (stopping) return
    supervisorLog(50, 'supervisor: docs-search exited', { code, signal })
  })
}

/**
 * Shut everything down on Ctrl+C (SIGINT) or a kill (SIGTERM): stop restarting, ask both
 * children to exit and give them a moment before the supervisor exits itself.
 */
function stop() {
  if (stopping) return
  stopping = true
  supervisorLog(30, 'supervisor: stopping', { restarts })
  api?.kill()
  docs?.kill()
  setTimeout(() => process.exit(0), 300)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)

supervisorLog(30, 'supervisor: starting loan-api', { heapMB: Number(values.heap), metricsIntervalMs: Number(values['metrics-interval']) })
startApi()
if (!values['no-docs']) startDocs()
