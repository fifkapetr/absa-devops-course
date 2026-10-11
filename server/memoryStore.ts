import { readFile } from 'node:fs/promises'
import type { LoanApplication } from '../shared/loan'
import type { LoanStore } from './loanStore'

/**
 * In-memory fallback used when the data file is not writable (release 1.2.0).
 * Starts from the seed and keeps every change in process memory only:
 * the API keeps working, but everything is lost when the process stops.
 */
export async function createMemoryLoanStore(seedPath: string): Promise<LoanStore> {
  const seed = JSON.parse(await readFile(seedPath, 'utf8')) as LoanApplication[]
  let loans: LoanApplication[] = structuredClone(seed)
  let chain: Promise<unknown> = Promise.resolve()

  return {
    async read() {
      return loans
    },
    update<T>(mutate: (loans: LoanApplication[]) => T): Promise<T> {
      const run = chain.then(async () => mutate(loans))
      chain = run.catch(() => undefined)
      return run
    },
    async reset() {
      loans = structuredClone(seed)
    }
  }
}
