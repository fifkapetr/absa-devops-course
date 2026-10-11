/**
 * Small seeded pseudo-random generator (mulberry32) so that generated data is reproducible:
 * the same seed always produces the same sequence on every platform.
 */
export interface Rng {
  next(): number                              // 0 <= x < 1
  int(min: number, max: number): number       // whole number, both ends inclusive
  pick<T>(items: readonly T[]): T
  chance(probability: number): boolean
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: items => items[Math.floor(next() * items.length)]!,
    chance: probability => next() < probability
  }
}

/** A hex string of `length` characters, e.g. a fake reqId */
export function hex(rng: Rng, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += rng.int(0, 15).toString(16)
  return out
}
