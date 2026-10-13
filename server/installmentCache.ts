import type { InstallmentRequest, InstallmentResult, InstallmentRow } from '../shared/loan'

/**
 * Cache installment results to speed up the calculator.
 * The UI calls the calculator while the officer types, so the same request arrives many
 * times; serving the pre-rendered answer from memory keeps the form responsive.
 */
interface FormattedRow extends InstallmentRow {
  dueDateText: string
  paymentText: string
  principalText: string
  interestText: string
  balanceText: string
}

interface CacheEntry {
  result: InstallmentResult
  response: string          // JSON, serialized once and sent as-is on a hit
  rows: FormattedRow[]      // schedule pre-formatted for the table view
  csv: string               // schedule pre-rendered for the "download schedule" export
  html: string              // schedule pre-rendered for the print preview
  expiresAt: number
  hits: number
}

const MAX_SIZE = 500
const TTL_MS = 5 * 60 * 1000

const cache = new Map<string, CacheEntry>()
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const longDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' })

// Key covers only the three values that affect the schedule; requestedAt and applicantName are excluded.
export function cacheKey(request: InstallmentRequest): string {
  return `${request.amount}:${request.termMonths}:${request.interestRate}`
}

export function getCached(key: string): CacheEntry | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return undefined
  }
  entry.hits++
  // Re-insert to mark as most recently used
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

export function putCached(key: string, result: InstallmentResult): CacheEntry {
  const rows: FormattedRow[] = result.schedule.map(row => ({
    ...row,
    dueDateText: longDate.format(new Date(row.dueDate)),
    paymentText: currency.format(row.payment),
    principalText: currency.format(row.principal),
    interestText: currency.format(row.interest),
    balanceText: currency.format(row.balance)
  }))
  const entry: CacheEntry = {
    result,
    response: JSON.stringify(result, null, 2),
    rows,
    csv: ['month;dueDate;payment;principal;interest;balance', ...rows.map(row => `${row.month};${row.dueDate};${row.payment};${row.principal};${row.interest};${row.balance}`)].join('\n'),
    html: rows
      .map(
        row =>
          `<tr class="schedule-row" data-month="${row.month}"><td class="num">${row.month}</td><td class="date">${row.dueDateText}</td><td class="money">${row.paymentText}</td><td class="money">${row.principalText}</td><td class="money">${row.interestText}</td><td class="money">${row.balanceText}</td></tr>`
      )
      .join('\n'),
    expiresAt: Date.now() + TTL_MS,
    hits: 0
  }
  // Remove existing entry so the re-insert lands at the end (most recently used)
  if (cache.has(key)) cache.delete(key)
  // Evict the least recently used entry when at capacity
  if (cache.size >= MAX_SIZE) {
    cache.delete(cache.keys().next().value!)
  }
  cache.set(key, entry)
  return entry
}

export function cacheSize(): number {
  return cache.size
}

/** Exposed for tests only */
export function clearCache(): void {
  cache.clear()
}
