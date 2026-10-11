import { appendFile } from 'node:fs/promises'

/**
 * Decision audit trail (release 1.2.0).
 * Every approve, reject and auto-decide appends one JSON line to AUDIT_FILE
 * before the decision is saved: no audit line, no decision.
 */
export interface AuditEntry {
  loanId: string
  decision: string
  reqId: string
}

export interface AuditLog {
  readonly filePath: string
  record(entry: AuditEntry): Promise<void>
}

/**
 * Thrown when the audit line cannot be written. The message is the file system error
 * (for example `EACCES: permission denied, open '/data/audit.log'`) so the operator sees the path.
 */
export class AuditWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuditWriteError'
  }
}

export function createAuditLog(filePath: string): AuditLog {
  return {
    filePath,
    async record(entry) {
      const line = JSON.stringify({ time: new Date().toISOString(), ...entry })
      try {
        await appendFile(filePath, line + '\n')
      } catch (err) {
        throw new AuditWriteError(err instanceof Error ? err.message : String(err), { cause: err })
      }
    }
  }
}
