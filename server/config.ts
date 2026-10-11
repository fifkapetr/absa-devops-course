import { createRequire } from 'node:module'
import path from 'node:path'
import type { Level } from 'pino'

/**
 * Runtime configuration.
 * Everything has a local default so `npm run dev` just works;
 * environment variables let you override ports and paths.
 */
const serverDir = import.meta.dirname
const rootDir = path.resolve(serverDir, '..')
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const config = {
  version,
  port: Number(process.env.PORT ?? 3000),
  dataFile: process.env.DATA_FILE ?? path.join(serverDir, 'data', 'loans.json'),
  seedFile: path.join(serverDir, 'data', 'loans.seed.json'),
  auditFile: process.env.AUDIT_FILE ?? path.join(serverDir, 'data', 'audit.log'),
  logFile: process.env.LOG_FILE ?? path.join(rootDir, 'logs', 'app.log'),
  logLevel: (process.env.LOG_LEVEL ?? 'info') as Level,
  metricsIntervalMs: Number(process.env.METRICS_INTERVAL_MS ?? 60_000),
  staticDir: path.join(rootDir, 'dist')
}
