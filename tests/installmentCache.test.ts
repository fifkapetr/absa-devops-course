// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildInstallmentSchedule } from '../shared/loanRules'
import { cacheKey, cacheSize, clearCache, getCached, putCached } from '../server/installmentCache'
import type { InstallmentRequest } from '../shared/loan'

const base: InstallmentRequest = { applicantName: 'Alice', amount: 10000, termMonths: 12, interestRate: 0.05 }
const result = buildInstallmentSchedule(base, new Date('2026-01-01'))

afterEach(() => {
  clearCache()
  vi.useRealTimers()
})

describe('cacheKey', () => {
  it('returns the same key regardless of applicantName', () => {
    const a = cacheKey({ ...base, applicantName: 'Alice' })
    const b = cacheKey({ ...base, applicantName: 'Bob' })
    expect(a).toBe(b)
  })

  it('returns the same key regardless of requestedAt', () => {
    const a = cacheKey({ ...base, requestedAt: '2026-01-01T00:00:00Z' })
    const b = cacheKey({ ...base, requestedAt: '2026-06-15T12:00:00Z' })
    expect(a).toBe(b)
  })

  it('returns a different key when a numeric input changes', () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, amount: 20000 }))
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, termMonths: 24 }))
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, interestRate: 0.08 }))
  })
})

describe('LRU eviction at 500 entries', () => {
  it('evicts the least recently used entry when the limit is reached', () => {
    // Fill the cache to exactly 500 entries
    for (let i = 0; i < 500; i++) {
      putCached(`key-${i}`, result)
    }
    expect(cacheSize()).toBe(500)

    // Adding one more entry must evict key-0 (oldest, never accessed)
    putCached('key-500', result)
    expect(cacheSize()).toBe(500)
    expect(getCached('key-0')).toBeUndefined()
    expect(getCached('key-500')).toBeDefined()
  })

  it('keeps a touched entry alive past its insertion position', () => {
    for (let i = 0; i < 500; i++) {
      putCached(`key-${i}`, result)
    }
    // Touch key-0 so it moves to the most-recently-used end
    getCached('key-0')
    // Adding one new entry should evict key-1 (now the LRU), not key-0
    putCached('key-500', result)
    expect(getCached('key-0')).toBeDefined()
    expect(getCached('key-1')).toBeUndefined()
  })
})

describe('TTL expiry', () => {
  it('returns undefined for an entry older than 5 minutes', () => {
    vi.useFakeTimers()
    const key = cacheKey(base)
    putCached(key, result)
    expect(getCached(key)).toBeDefined()

    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(getCached(key)).toBeUndefined()
    expect(cacheSize()).toBe(0)
  })
})
