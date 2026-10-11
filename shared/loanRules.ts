import type { CreateLoanInput, InstallmentResult, InstallmentRow, LoanApplication, LoanStatus } from './loan'

/**
 * Business rules of the Tredgate lending policy.
 * Pure functions with no I/O: the server uses them for decisions,
 * the UI uses them for display.
 */

/**
 * Thrown when a loan application does not satisfy the lending policy
 */
export class LoanValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoanValidationError'
  }
}

/**
 * Auto-decision limits: a loan within both limits is approved, anything else is rejected
 */
export const AUTO_APPROVE_MAX_AMOUNT = 100_000
export const AUTO_APPROVE_MAX_TERM_MONTHS = 60

/**
 * Validate the input for a new loan application.
 * The input may come straight from an HTTP request, so types are checked as well.
 */
export function validateLoanInput(input: CreateLoanInput): void {
  if (typeof input !== 'object' || input === null) {
    throw new LoanValidationError('Request body must be a JSON object')
  }
  if (typeof input.applicantName !== 'string' || input.applicantName.trim() === '') {
    throw new LoanValidationError('Applicant name is required')
  }
  if (typeof input.amount !== 'number' || !(input.amount > 0)) {
    throw new LoanValidationError('Amount must be a number greater than 0')
  }
  if (!Number.isInteger(input.termMonths) || input.termMonths <= 0) {
    throw new LoanValidationError('Term months must be a whole number greater than 0')
  }
  if (typeof input.interestRate !== 'number' || !(input.interestRate >= 0 && input.interestRate <= 1)) {
    throw new LoanValidationError('Interest rate must be between 0 and 1 (e.g. 0.08 for 8%)')
  }
}

/**
 * Decide on a loan automatically:
 * - amount <= 100000 AND termMonths <= 60 → approved
 * - otherwise → rejected
 */
export function decideLoan(loan: Pick<LoanApplication, 'amount' | 'termMonths'>): LoanStatus {
  if (loan.amount <= AUTO_APPROVE_MAX_AMOUNT && loan.termMonths <= AUTO_APPROVE_MAX_TERM_MONTHS) {
    return 'approved'
  }
  return 'rejected'
}

/**
 * Calculate the monthly payment for a loan
 * Uses a simple formula: total = amount * (1 + interestRate), monthly = total / termMonths
 */
export function calculateMonthlyPayment(
  loan: Pick<LoanApplication, 'amount' | 'termMonths' | 'interestRate'>
): number {
  const total = loan.amount * (1 + loan.interestRate)
  return total / loan.termMonths
}

/**
 * Build the full amortization schedule for the flat-rate formula of POL-030.
 * Principal and interest are spread evenly over the term; the last row absorbs rounding.
 * `startDate` is the date the loan is requested; the first installment is due one month later.
 */
export function buildInstallmentSchedule(
  loan: Pick<LoanApplication, 'amount' | 'termMonths' | 'interestRate'>,
  startDate: Date = new Date()
): InstallmentResult {
  const monthlyPayment = round2(calculateMonthlyPayment(loan))
  const totalInterest = round2(loan.amount * loan.interestRate)
  const totalRepayable = round2(loan.amount + totalInterest)
  const monthlyInterest = round2(totalInterest / loan.termMonths)
  const monthlyPrincipal = round2(loan.amount / loan.termMonths)

  const schedule: InstallmentRow[] = []
  let balance = loan.amount
  for (let month = 1; month <= loan.termMonths; month++) {
    const last = month === loan.termMonths
    const principal = last ? round2(balance) : monthlyPrincipal
    const interest = last ? round2(totalInterest - monthlyInterest * (loan.termMonths - 1)) : monthlyInterest
    balance = last ? 0 : round2(balance - principal)
    schedule.push({
      month,
      dueDate: addMonths(startDate, month),
      payment: round2(principal + interest),
      principal,
      interest,
      balance
    })
  }

  return { monthlyPayment, totalRepayable, totalInterest, schedule }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function addMonths(date: Date, months: number): string {
  const due = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, Math.min(date.getUTCDate(), 28)))
  return due.toISOString().slice(0, 10)
}
