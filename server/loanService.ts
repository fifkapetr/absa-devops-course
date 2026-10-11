import type { CreateLoanInput, LoanApplication, LoanStatus } from '../shared/loan'
import { decideLoan, validateLoanInput } from '../shared/loanRules'
import type { AuditLog } from './auditLog'
import { HttpError } from './errors'
import type { LoanStore } from './loanStore'

/**
 * Loan use cases. Each write is a single, serialized store update.
 * Decisions are written to the audit trail first (1.2.0): if that fails, nothing is saved.
 */
export function createLoanService(store: LoanStore, audit?: AuditLog) {
  return {
    list(): Promise<LoanApplication[]> {
      return store.read()
    },

    async get(id: string): Promise<LoanApplication> {
      const loan = (await store.read()).find(l => l.id === id)
      if (!loan) {
        throw new HttpError(404, `Loan with id ${id} not found`)
      }
      return loan
    },

    create(input: CreateLoanInput): Promise<LoanApplication> {
      validateLoanInput(input)

      return store.update(loans => {
        const loan: LoanApplication = {
          id: generateId(),
          applicantName: input.applicantName.trim(),
          amount: input.amount,
          termMonths: input.termMonths,
          interestRate: input.interestRate,
          status: 'pending',
          createdAt: new Date().toISOString()
        }
        loans.push(loan)
        return loan
      })
    },

    async updateStatus(id: string, status: LoanStatus, reqId = '-'): Promise<LoanApplication> {
      findPendingLoan(await store.read(), id)
      await audit?.record({ loanId: id, decision: status, reqId })
      return store.update(loans => {
        const loan = findPendingLoan(loans, id)
        loan.status = status
        return loan
      })
    },

    async autoDecide(id: string, reqId = '-'): Promise<LoanApplication> {
      const decision = decideLoan(findPendingLoan(await store.read(), id))
      await audit?.record({ loanId: id, decision, reqId })
      return store.update(loans => {
        const loan = findPendingLoan(loans, id)
        loan.status = decision
        return loan
      })
    }
  }
}

export type LoanService = ReturnType<typeof createLoanService>

/**
 * Decisions are final: only a pending loan can be approved, rejected or auto-decided
 */
function findPendingLoan(loans: LoanApplication[], id: string): LoanApplication {
  const loan = loans.find(l => l.id === id)
  if (!loan) {
    throw new HttpError(404, `Loan with id ${id} not found`)
  }
  if (loan.status !== 'pending') {
    throw new HttpError(409, `Loan with id ${id} has already been decided (${loan.status})`)
  }
  return loan
}

/**
 * Generate a simple unique ID
 */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9)
}
