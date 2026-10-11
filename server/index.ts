import { existsSync } from 'node:fs'
import { createApp } from './app'
import { createAuditLog } from './auditLog'
import { config } from './config'
import { cacheSize } from './installmentCache'
import { createLogger } from './logger'
import { createLoanStore } from './loanStore'
import { createMemoryLoanStore } from './memoryStore'
import { startProcessMetrics } from './metrics'
import { checkWritable } from './persistence'

const logger = createLogger(config.logFile, config.logLevel)
const staticDir = existsSync(config.staticDir) ? config.staticDir : undefined

// Since 1.2.0: when the data file cannot be written, keep serving from memory (seed data) instead of failing
const unwritable = await checkWritable(config.dataFile)
const store = unwritable
  ? await createMemoryLoanStore(config.seedFile)
  : createLoanStore({ filePath: config.dataFile, seedPath: config.seedFile })
if (unwritable) {
  logger.warn({ reason: unwritable }, 'persistence disabled')
}

const app = createApp({ store, logger, audit: createAuditLog(config.auditFile), version: config.version, staticDir })

// Make sure the data file exists before the first request (it is created from the seed when missing)
await store.read()

app.listen(config.port, (err?: Error) => {
  if (err) {
    // Typically EADDRINUSE: another instance is already listening on this port (see runbook RB-004)
    logger.error({ err, port: config.port }, 'Tredgate Loan API failed to start')
    process.exit(1)
  }
  logger.info(
    {
      version: config.version,
      port: config.port,
      dataFile: config.dataFile,
      logFile: config.logFile,
      servingFrontend: Boolean(staticDir)
    },
    'Tredgate Loan API started'
  )
  startProcessMetrics(logger, config.metricsIntervalMs, cacheSize)
})
