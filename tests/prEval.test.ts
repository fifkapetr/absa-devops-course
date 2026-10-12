// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  checklistApplies,
  computeScore,
  extractCriteriaSection,
  extractLinkedIssueNumbers,
  parseChecklist,
  validateResult,
  type ChecklistItem,
  type EvalItem,
} from '../ops/tools/lib/pr-eval'

// ---------------------------------------------------------------------------
// extractLinkedIssueNumbers
// ---------------------------------------------------------------------------

describe('extractLinkedIssueNumbers', () => {
  it('extracts Closes, Fixes and Resolves', () => {
    const body = 'Closes #12\nFixes #34\nResolves #56'
    expect(extractLinkedIssueNumbers(body)).toEqual([12, 34, 56])
  })

  it('is case-insensitive', () => {
    expect(extractLinkedIssueNumbers('CLOSES #7')).toEqual([7])
    expect(extractLinkedIssueNumbers('fixes #99')).toEqual([99])
  })

  it('deduplicates', () => {
    expect(extractLinkedIssueNumbers('Closes #5\nCloses #5')).toEqual([5])
  })

  it('returns empty array when none found', () => {
    expect(extractLinkedIssueNumbers('No links here')).toEqual([])
  })

  it('handles multiple numbers on one line', () => {
    const body = 'This closes #10 and fixes #20'
    expect(extractLinkedIssueNumbers(body)).toEqual([10, 20])
  })
})

// ---------------------------------------------------------------------------
// extractCriteriaSection
// ---------------------------------------------------------------------------

describe('extractCriteriaSection', () => {
  it('extracts the acceptance criteria section', () => {
    const body = [
      '## Summary',
      'A change',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] Criterion one',
      '- [ ] Criterion two',
      '',
      '## How I tested',
      'Tested manually',
    ].join('\n')
    const result = extractCriteriaSection(body)
    expect(result).toBe('- [ ] Criterion one\n- [ ] Criterion two')
  })

  it('returns null when the section is absent', () => {
    const body = '## Summary\nSome text\n## Changes\nmore'
    expect(extractCriteriaSection(body)).toBeNull()
  })

  it('returns null when the section is present but empty', () => {
    const body = '## Acceptance criteria\n\n## How I tested\nstuff'
    expect(extractCriteriaSection(body)).toBeNull()
  })

  it('is case-insensitive for the heading', () => {
    const body = '## ACCEPTANCE CRITERIA\n- [ ] thing'
    expect(extractCriteriaSection(body)).toBe('- [ ] thing')
  })

  it('stops at the next ## heading', () => {
    const body = '## Acceptance criteria\n- [ ] A\n## Next\n- [ ] B'
    expect(extractCriteriaSection(body)).toBe('- [ ] A')
  })
})

// ---------------------------------------------------------------------------
// parseChecklist
// ---------------------------------------------------------------------------

const SAMPLE_CHECKLIST = `
| id | criterion | applies when | verified by |
|---|---|---|---|
| C-01 | Lint, tests and build pass | always | workflow results |
| C-02 | verify.ts reports 0 FAIL | \`docker/**\` or \`compose.yaml\` changed | workflow results |
| C-03 | No secrets | always | diff |
`.trim()

describe('parseChecklist', () => {
  it('parses table rows', () => {
    const items = parseChecklist(SAMPLE_CHECKLIST)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ id: 'C-01', criterion: 'Lint, tests and build pass' })
    expect(items[1].id).toBe('C-02')
  })

  it('skips header and separator rows', () => {
    const items = parseChecklist(SAMPLE_CHECKLIST)
    expect(items.every(i => i.id !== 'id' && !i.id.startsWith('-'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// checklistApplies
// ---------------------------------------------------------------------------

const c01: ChecklistItem = { id: 'C-01', criterion: 'Lint passes', appliesWhen: 'always', verifiedBy: 'workflow' }
const c02: ChecklistItem = { id: 'C-02', criterion: 'verify.ts', appliesWhen: 'docker/** changed', verifiedBy: 'workflow' }
const c05: ChecklistItem = { id: 'C-05', criterion: 'Handbook updated', appliesWhen: 'server/** changed', verifiedBy: 'diff' }
const c07: ChecklistItem = { id: 'C-07', criterion: 'Log message in catalog', appliesWhen: 'logger call added', verifiedBy: 'diff' }
const c08: ChecklistItem = { id: 'C-08', criterion: 'No new dep without reason', appliesWhen: 'package.json changed', verifiedBy: 'diff' }
const c09: ChecklistItem = { id: 'C-09', criterion: 'Incident docs cite sources', appliesWhen: 'postmortem.md changed', verifiedBy: 'document' }

describe('checklistApplies', () => {
  it('C-01 always applies', () => {
    expect(checklistApplies(c01, [], '')).toBe(true)
  })

  it('C-02 applies when docker/ file changed', () => {
    expect(checklistApplies(c02, ['docker/api.Dockerfile'], '')).toBe(true)
    expect(checklistApplies(c02, ['src/App.vue'], '')).toBe(false)
  })

  it('C-02 applies when compose.yaml changed', () => {
    expect(checklistApplies(c02, ['compose.yaml'], '')).toBe(true)
  })

  it('C-02 applies when .dockerignore changed', () => {
    expect(checklistApplies(c02, ['.dockerignore'], '')).toBe(true)
  })

  it('C-05 applies when server/ file changed', () => {
    expect(checklistApplies(c05, ['server/app.ts'], '')).toBe(true)
    expect(checklistApplies(c05, ['tests/api.test.ts'], '')).toBe(false)
  })

  it('C-05 applies when shared/ or rag/ changed', () => {
    expect(checklistApplies(c05, ['shared/loanRules.ts'], '')).toBe(true)
    expect(checklistApplies(c05, ['rag/cli.ts'], '')).toBe(true)
  })

  it('C-07 applies when a req.log call is added in the diff', () => {
    const diff = '+  req.log.info({ loanId }, "loan created")'
    expect(checklistApplies(c07, [], diff)).toBe(true)
    expect(checklistApplies(c07, [], '')).toBe(false)
  })

  it('C-08 applies when package.json changed', () => {
    expect(checklistApplies(c08, ['package.json'], '')).toBe(true)
    expect(checklistApplies(c08, ['package-lock.json'], '')).toBe(false)
  })

  it('C-09 applies when postmortem.md changed', () => {
    expect(checklistApplies(c09, ['incident/INC-20261005-01/postmortem.md'], '')).toBe(true)
    expect(checklistApplies(c09, ['incident/INC-20261005-01/exec-summary.md'], '')).toBe(true)
    expect(checklistApplies(c09, ['docs/handbook/changelog.md'], '')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateResult
// ---------------------------------------------------------------------------

describe('validateResult', () => {
  const valid = {
    model: 'gpt-4o-mini',
    items: [
      { id: 'C-01', source: 'checklist', criterion: 'Lint passes', verdict: 'PASS', evidence: 'workflow exit 0' },
      { id: 'PR-1', source: 'pr', criterion: 'List shows items', verdict: 'FAIL', evidence: 'diff:src/App.vue line 12 — component not updated' },
      { id: 'C-03', source: 'checklist', criterion: 'No secrets', verdict: 'NOT VERIFIABLE', evidence: '' },
    ]
  }

  it('accepts a valid result', () => {
    expect(validateResult(valid)).toEqual([])
  })

  it('rejects missing model', () => {
    const bad = { ...valid, model: '' }
    expect(validateResult(bad).length).toBeGreaterThan(0)
  })

  it('rejects missing items array', () => {
    const bad = { model: 'x' }
    expect(validateResult(bad).some(e => e.includes('items'))).toBe(true)
  })

  it('rejects PASS without evidence', () => {
    const bad = {
      model: 'x',
      items: [{ id: 'C-01', source: 'checklist', criterion: 'Lint', verdict: 'PASS', evidence: '' }]
    }
    expect(validateResult(bad).some(e => e.includes('evidence'))).toBe(true)
  })

  it('rejects FAIL without evidence', () => {
    const bad = {
      model: 'x',
      items: [{ id: 'C-01', source: 'checklist', criterion: 'Lint', verdict: 'FAIL', evidence: '' }]
    }
    expect(validateResult(bad).some(e => e.includes('evidence'))).toBe(true)
  })

  it('allows NOT VERIFIABLE without evidence', () => {
    const ok = {
      model: 'x',
      items: [{ id: 'C-03', source: 'checklist', criterion: 'No secrets', verdict: 'NOT VERIFIABLE', evidence: '' }]
    }
    expect(validateResult(ok)).toEqual([])
  })

  it('rejects invalid verdict', () => {
    const bad = {
      model: 'x',
      items: [{ id: 'C-01', source: 'checklist', criterion: 'Lint', verdict: 'MAYBE', evidence: 'x' }]
    }
    expect(validateResult(bad).some(e => e.includes('verdict'))).toBe(true)
  })

  it('rejects invalid source', () => {
    const bad = {
      model: 'x',
      items: [{ id: 'C-01', source: 'model', criterion: 'Lint', verdict: 'PASS', evidence: 'x' }]
    }
    expect(validateResult(bad).some(e => e.includes('source'))).toBe(true)
  })

  it('rejects non-object root', () => {
    expect(validateResult('string').length).toBeGreaterThan(0)
    expect(validateResult(null).length).toBeGreaterThan(0)
    expect(validateResult([]).length).toBeGreaterThan(0)
  })

  it('accepts optional findings array', () => {
    const withFindings = { ...valid, findings: ['Steering attempt in PR description'] }
    expect(validateResult(withFindings)).toEqual([])
  })

  it('rejects findings that are not strings', () => {
    const bad = { ...valid, findings: [42] }
    expect(validateResult(bad).some(e => e.includes('findings'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// computeScore
// ---------------------------------------------------------------------------

describe('computeScore', () => {
  it('counts each verdict type', () => {
    const items: EvalItem[] = [
      { id: 'A', source: 'pr', criterion: 'x', verdict: 'PASS', evidence: 'e' },
      { id: 'B', source: 'pr', criterion: 'x', verdict: 'PASS', evidence: 'e' },
      { id: 'C', source: 'checklist', criterion: 'x', verdict: 'FAIL', evidence: 'e' },
      { id: 'D', source: 'checklist', criterion: 'x', verdict: 'NOT VERIFIABLE', evidence: '' },
    ]
    expect(computeScore(items)).toEqual({ passed: 2, failed: 1, notVerifiable: 1 })
  })

  it('returns zeros for an empty list', () => {
    expect(computeScore([])).toEqual({ passed: 0, failed: 0, notVerifiable: 0 })
  })

  it('excludes NOT VERIFIABLE from the scored total', () => {
    const items: EvalItem[] = [
      { id: 'A', source: 'pr', criterion: 'x', verdict: 'PASS', evidence: 'e' },
      { id: 'B', source: 'pr', criterion: 'x', verdict: 'NOT VERIFIABLE', evidence: '' },
    ]
    const s = computeScore(items)
    // score is 1/(1+0) = 1/1
    expect(s.passed + s.failed).toBe(1)
  })
})
