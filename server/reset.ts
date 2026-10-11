import { rm } from 'node:fs/promises'
import { config } from './config'
import { createLoanStore } from './loanStore'

// Restore the data file from the seed and clear the audit trail: `npm run data:reset`
const store = createLoanStore({ filePath: config.dataFile, seedPath: config.seedFile })
await store.reset()
await rm(config.auditFile, { force: true })
console.log(`Loan data reset from seed: ${config.dataFile}`)
console.log(`Audit trail cleared: ${config.auditFile}`)
