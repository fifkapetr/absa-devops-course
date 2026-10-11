/**
 * Loan domain types shared by the frontend (src/) and the backend (server/).
 */

/**
 * Union type for loan application status
 */
export type LoanStatus = 'pending' | 'approved' | 'rejected'

/**
 * Represents a loan application
 */
export interface LoanApplication {
  id: string
  applicantName: string
  amount: number        // loan amount
  termMonths: number    // number of months to repay
  interestRate: number  // e.g. 0.08 for 8% p.a.
  status: LoanStatus
  createdAt: string     // ISO timestamp
}

/**
 * Input for creating a new loan application
 */
export interface CreateLoanInput {
  applicantName: string
  amount: number
  termMonths: number
  interestRate: number
}

/**
 * Input for the installment calculator (POST /api/installments/calculate).
 * `requestedAt` is the moment the officer asked; the schedule starts the month after it.
 */
export interface InstallmentRequest extends CreateLoanInput {
  requestedAt?: string  // ISO timestamp
}

/**
 * One row of an amortization schedule
 */
export interface InstallmentRow {
  month: number         // 1..termMonths
  dueDate: string       // YYYY-MM-DD
  payment: number       // monthly installment
  principal: number     // part of the payment that repays the amount
  interest: number      // part of the payment that is interest
  balance: number       // amount still owed after this payment
}

/**
 * Result of the installment calculator
 */
export interface InstallmentResult {
  monthlyPayment: number
  totalRepayable: number
  totalInterest: number
  schedule: InstallmentRow[]
}
