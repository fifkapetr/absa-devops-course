import { rm } from 'node:fs/promises'
import { config } from './config'
import { createLoanStore } from './loanStore'

/**
 * npm run data:reset
 *
 * Restore the data file from the seed and clear the audit trail. Puts the app's data back to the
 * state of a fresh checkout; use it after experiments, load tests or manual testing in the UI,
 * so the next run starts from known data.
 *
 *   1. The data file (server/data/loans.json) is overwritten with the committed seed
 *      (server/data/loans.seed.json). Loans you created or decided since then are gone.
 *   2. The audit trail (server/data/audit.log) is deleted. The API starts a new one with the next decision.
 *
 * DATA_FILE and AUDIT_FILE are respected (server/config.ts), so with those environment variables
 * set the command resets that copy instead of the default files. The seed file is never changed.
 *
 * Usage:
 *   npm run data:reset
 *   npx tsx server/reset.ts
 */
const store = createLoanStore({ filePath: config.dataFile, seedPath: config.seedFile })
await store.reset() // copies the seed over the data file
// `force: true`: no error when the audit file does not exist yet
await rm(config.auditFile, { force: true })
console.log(`Loan data reset from seed: ${config.dataFile}`)
console.log(`Audit trail cleared: ${config.auditFile}`)
