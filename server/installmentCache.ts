import type { InstallmentRequest, InstallmentResult } from '../shared/loan'

/**
 * Cache installment results to speed up the calculator.
 * The UI calls the calculator while the officer types, so the same request
 * arrives many times; serving it from memory keeps the form responsive.
 */
interface CacheEntry {
  result: InstallmentResult
  response: string      // serialized once, sent as-is on a hit
  rows: string[]        // schedule rows pre-formatted for the table and the CSV export
  cachedAt: string
  hits: number
}

const cache = new Map<string, CacheEntry>()

export function cacheKey(request: InstallmentRequest): string {
  return JSON.stringify(request)
}

export function getCached(key: string): CacheEntry | undefined {
  const entry = cache.get(key)
  if (entry) entry.hits++
  return entry
}

export function putCached(key: string, result: InstallmentResult): CacheEntry {
  const entry: CacheEntry = {
    result,
    response: JSON.stringify(result),
    rows: result.schedule.map(
      row =>
        `${row.month};${row.dueDate};${row.payment.toFixed(2)};${row.principal.toFixed(2)};${row.interest.toFixed(2)};${row.balance.toFixed(2)}`
    ),
    cachedAt: new Date().toISOString(),
    hits: 0
  }
  cache.set(key, entry)
  return entry
}

export function cacheSize(): number {
  return cache.size
}
