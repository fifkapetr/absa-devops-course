import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { parseCli } from './lib/cli'

/**
 * npm run ops:incident
 *
 * Runs the loan API the way the container pilot does: under a supervisor that restarts it
 * when it exits, with a small heap and frequent `process metrics` lines. The handbook search
 * (docs-search, port 3001) is started alongside so `npm run ops:load` has both targets.
 * Nothing is built; the API serves the existing dist/ if there is one.
 */
const { values } = parseCli(
  'npm run ops:incident',
  'Starts loan-api under a restarting supervisor with a limited heap, plus docs-search.',
  {
    heap: { type: 'string', default: '96', description: 'V8 old-space limit for loan-api in MB (--max-old-space-size)' },
    'metrics-interval': { type: 'string', default: '5000', description: 'METRICS_INTERVAL_MS for loan-api' },
    'no-docs': { type: 'boolean', default: false, description: 'Do not start docs-search on port 3001' }
  }
)

const root = path.resolve(import.meta.dirname, '..', '..')
const logFile = process.env.LOG_FILE ?? path.join(root, 'logs', 'app.log')
mkdirSync(path.dirname(logFile), { recursive: true })

let restarts = 0
let stopping = false
let api: ChildProcess | undefined
let docs: ChildProcess | undefined

function supervisorLog(level: number, msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), ...fields, msg })
  console.log(line)
  try {
    appendFileSync(logFile, line + '\n')
  } catch {
    // the log folder may be unwritable; the terminal still has the line
  }
}

function startApi() {
  api = spawn(process.execPath, [`--max-old-space-size=${values.heap}`, '--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, METRICS_INTERVAL_MS: values['metrics-interval'], LOG_FILE: logFile }
  })
  api.on('exit', (code, signal) => {
    if (stopping) return
    supervisorLog(50, 'supervisor: loan-api exited', { code, signal, restarts })
    restarts++
    setTimeout(startApi, 1000)
  })
}

function startDocs() {
  docs = spawn(process.execPath, ['--import', 'tsx', 'rag/server.ts'], { cwd: root, stdio: 'inherit', env: process.env })
  docs.on('exit', (code, signal) => {
    if (stopping) return
    supervisorLog(50, 'supervisor: docs-search exited', { code, signal })
  })
}

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
