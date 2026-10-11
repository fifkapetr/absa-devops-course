import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Can the process write the data file? Returns `undefined` when it can,
 * otherwise a short reason such as `EACCES /data/loans.json` for the `persistence disabled` log line.
 */
export async function checkWritable(filePath: string): Promise<string | undefined> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    try {
      await access(filePath, constants.W_OK)
    } catch (err) {
      // A missing file is fine as long as the folder is writable (the seed is copied there)
      if (!isCode(err, 'ENOENT')) throw err
      await access(path.dirname(filePath), constants.W_OK)
    }
    return undefined
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'ERROR'
    return `${code} ${filePath}`
  }
}

function isCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code
}
