import type { Logger } from './logger'

/**
 * Process metrics (release 1.2.0): one `process metrics` line every METRICS_INTERVAL_MS
 * with heap, resident memory, installment cache size and uptime.
 */
export function startProcessMetrics(logger: Logger, intervalMs: number, cacheEntries: () => number): NodeJS.Timeout {
  const timer = setInterval(() => {
    const memory = process.memoryUsage()
    logger.info(
      {
        heapUsedMB: Math.round(memory.heapUsed / 1048576),
        rssMB: Math.round(memory.rss / 1048576),
        cacheEntries: cacheEntries(),
        uptimeSeconds: Math.round(process.uptime())
      },
      'process metrics'
    )
  }, intervalMs)
  timer.unref()
  return timer
}
