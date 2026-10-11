import type { Rng } from './random'

/**
 * Fictional applicants for load tests and generated logs. None of them is a real person.
 * The pool is deliberately small so that "distinct applicant names in the log" is a countable number.
 */
const FIRST_NAMES = [
  'Adela', 'Bohumil', 'Cyril', 'Dagmar', 'Emil', 'Filip', 'Gabriela', 'Hynek', 'Ivana', 'Jarmila',
  'Kamil', 'Ludmila', 'Milos', 'Nadezda', 'Oldrich', 'Pavlina', 'Radek', 'Simona', 'Tadeas', 'Vlasta',
  'Zbynek', 'Alzbeta', 'Bedrich', 'Darina', 'Erik', 'Frantiska', 'Gustav', 'Helena', 'Igor', 'Jindrich'
]
const LAST_NAMES = [
  'Prochazka', 'Cerny', 'Kucera', 'Vesely', 'Horak', 'Nemec', 'Pokorny', 'Pospisil', 'Hajek', 'Jelinek',
  'Kral', 'Ruzicka', 'Fiala', 'Sedlacek', 'Dolezal', 'Zeman', 'Kolar', 'Navratil', 'Urban', 'Blaha'
]

export function fakeApplicantName(rng: Rng): string {
  return `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`
}

export const APPLICANT_NAME_POOL_SIZE = FIRST_NAMES.length * LAST_NAMES.length

/** A plausible calculator request: Simple Personal Loan range of POL-020 */
export function fakeCalculation(rng: Rng) {
  return {
    applicantName: fakeApplicantName(rng),
    amount: rng.int(10, 2500) * 100,
    termMonths: rng.int(12, 84),
    interestRate: [0.05, 0.06, 0.07, 0.075, 0.08, 0.085, 0.09, 0.1][rng.int(0, 7)]!
  }
}

/** Questions officers ask the handbook search */
export const SEARCH_QUESTIONS = [
  'maximum amount for automatic approval',
  'how is the monthly installment calculated',
  'what does the interest rate 0.08 mean',
  'who may approve a 120000 loan',
  'request rejected reason interest rate must be between 0 and 1',
  'failed to load loan applications',
  'how to reset the data file',
  'incident severity S2 response time',
  'decision already decided 409',
  'data file truncated on shutdown',
  'postmortem template',
  'applicant name in logs'
]
