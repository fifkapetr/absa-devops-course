/**
 * Pure functions shared by pr-context.ts, pr-score.ts and the unit tests.
 * No side effects; no imports from outside node:*.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Verdict = 'PASS' | 'FAIL' | 'NOT VERIFIABLE'
export type Source = 'pr' | 'issue' | 'checklist'

export interface EvalItem {
  id: string
  source: Source
  criterion: string
  verdict: Verdict
  evidence: string
}

export interface ResultJson {
  model: string
  items: EvalItem[]
  findings?: string[]
}

export interface ChecklistItem {
  id: string
  criterion: string
  appliesWhen: string
  verifiedBy: string
}

export interface Score {
  passed: number
  failed: number
  notVerifiable: number
}

// ---------------------------------------------------------------------------
// Criteria extraction
// ---------------------------------------------------------------------------

/**
 * Extract the body of the `## Acceptance criteria` section from a Markdown text.
 * Returns the raw text of the section (lines until the next `##` heading), or
 * null when the section is absent.
 */
export function extractCriteriaSection(body: string): string | null {
  const lines = body.split('\n')
  let inside = false
  const result: string[] = []
  for (const line of lines) {
    if (/^##\s+acceptance criteria/i.test(line)) {
      inside = true
      continue
    }
    if (inside) {
      if (/^##\s/.test(line)) break
      result.push(line)
    }
  }
  if (!inside) return null
  const text = result.join('\n').trim()
  return text.length > 0 ? text : null
}

/**
 * Extract GitHub issue numbers from `Closes #N`, `Fixes #N`, `Resolves #N`
 * (case-insensitive) anywhere in the text.
 */
export function extractLinkedIssueNumbers(prBody: string): number[] {
  const seen = new Set<number>()
  const re = /(?:closes|fixes|resolves)\s+#(\d+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(prBody)) !== null) {
    seen.add(parseInt(m[1], 10))
  }
  return [...seen].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Checklist table parser
// ---------------------------------------------------------------------------

/**
 * Parse the Markdown table from checklist.md into structured items.
 * Rows that are header or separator lines are skipped.
 */
export function parseChecklist(markdown: string): ChecklistItem[] {
  const items: ChecklistItem[] = []
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const cols = line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1)
    if (cols.length < 4) continue
    const [id, criterion, appliesWhen, verifiedBy] = cols
    if (!id || /^-+$/.test(id) || id.toLowerCase() === 'id') continue
    items.push({ id, criterion, appliesWhen, verifiedBy })
  }
  return items
}

// ---------------------------------------------------------------------------
// Checklist applicability (code-driven, not model-driven)
// ---------------------------------------------------------------------------

type Condition = (changedFiles: string[], diffContent: string) => boolean

function matchesGlob(file: string, pattern: string): boolean {
  if (pattern === file) return true
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3)
    return file === prefix || file.startsWith(prefix + '/')
  }
  if (pattern.endsWith('/**/*.md')) {
    const prefix = pattern.slice(0, -7)
    return (file === prefix || file.startsWith(prefix + '/')) && file.endsWith('.md')
  }
  return false
}

const CONDITIONS: Record<string, Condition> = {
  'C-01': () => true,
  'C-02': (files) =>
    files.some(f =>
      matchesGlob(f, 'docker/**') ||
      f === 'compose.yaml' ||
      f === '.dockerignore'
    ),
  'C-03': () => true,
  'C-04': () => true,
  'C-05': (files) =>
    files.some(f =>
      matchesGlob(f, 'server/**') ||
      matchesGlob(f, 'shared/**') ||
      matchesGlob(f, 'rag/**')
    ),
  'C-06': () => true,
  'C-07': (_files, diff) =>
    /^\+[^+].*req\.log\.\w+\(/.test(diff) ||
    /^\+[^+].*logger\.(info|warn|error|debug)\(/.test(diff),
  'C-08': (files) => files.includes('package.json'),
  'C-09': (files) =>
    files.some(f =>
      (f.startsWith('incident/') && f.endsWith('/postmortem.md')) ||
      (f.startsWith('incident/') && f.endsWith('/exec-summary.md'))
    ),
}

/**
 * Whether a checklist item applies to the current change.
 * Unknown ids default to always-applicable (safe over-inclusion).
 */
export function checklistApplies(
  item: ChecklistItem,
  changedFiles: string[],
  diffContent: string
): boolean {
  const condition = CONDITIONS[item.id] ?? (() => true)
  return condition(changedFiles, diffContent)
}

// ---------------------------------------------------------------------------
// Result schema validation
// ---------------------------------------------------------------------------

const VALID_VERDICTS: Verdict[] = ['PASS', 'FAIL', 'NOT VERIFIABLE']
const VALID_SOURCES: Source[] = ['pr', 'issue', 'checklist']

/**
 * Validate a result.json object.
 * Returns a list of error messages; empty means valid.
 */
export function validateResult(data: unknown): string[] {
  const errors: string[] = []

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return ['root must be an object']
  }

  const obj = data as Record<string, unknown>

  if (typeof obj.model !== 'string' || obj.model.trim() === '') {
    errors.push('model must be a non-empty string')
  }

  if (!Array.isArray(obj.items)) {
    errors.push('items must be an array')
    return errors
  }

  for (let i = 0; i < obj.items.length; i++) {
    const item = obj.items[i] as Record<string, unknown>
    const prefix = `items[${i}]`

    if (typeof item !== 'object' || item === null) {
      errors.push(`${prefix} must be an object`); continue
    }
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      errors.push(`${prefix}.id must be a non-empty string`)
    }
    if (!VALID_SOURCES.includes(item.source as Source)) {
      errors.push(`${prefix}.source must be one of: ${VALID_SOURCES.join(', ')}`)
    }
    if (typeof item.criterion !== 'string' || item.criterion.trim() === '') {
      errors.push(`${prefix}.criterion must be a non-empty string`)
    }
    if (!VALID_VERDICTS.includes(item.verdict as Verdict)) {
      errors.push(`${prefix}.verdict must be one of: ${VALID_VERDICTS.join(', ')}`)
    }
    if (typeof item.evidence !== 'string') {
      errors.push(`${prefix}.evidence must be a string`)
    } else if (
      (item.verdict === 'PASS' || item.verdict === 'FAIL') &&
      item.evidence.trim() === ''
    ) {
      errors.push(`${prefix}: PASS or FAIL requires non-empty evidence`)
    }
  }

  if (obj.findings !== undefined && !Array.isArray(obj.findings)) {
    errors.push('findings must be an array when present')
  }
  if (Array.isArray(obj.findings)) {
    for (let i = 0; i < obj.findings.length; i++) {
      if (typeof obj.findings[i] !== 'string') {
        errors.push(`findings[${i}] must be a string`)
      }
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Compute passed / failed / not-verifiable counts from validated items. */
export function computeScore(items: EvalItem[]): Score {
  let passed = 0, failed = 0, notVerifiable = 0
  for (const item of items) {
    if (item.verdict === 'PASS') passed++
    else if (item.verdict === 'FAIL') failed++
    else notVerifiable++
  }
  return { passed, failed, notVerifiable }
}
