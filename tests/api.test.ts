// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pino } from 'pino'
import { createApp as createLoanApp } from '../server/app'
import { createAuditLog } from '../server/auditLog'
import { createLoanStore } from '../server/loanStore'
import { createMemoryLoanStore } from '../server/memoryStore'
import type { InstallmentResult, LoanApplication } from '../shared/loan'

const SEED_FILE = path.resolve('server/data/loans.seed.json')

type ErrorBody = { error: string }

let server: Server
let baseUrl: string
let dataDir: string
let auditFile: string

async function api<T>(route: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api${route}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function startServer(app: ReturnType<typeof createLoanApp>) {
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve())
  })
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
}

const newLoan = {
  applicantName: 'Alice Smith',
  amount: 25000,
  termMonths: 12,
  interestRate: 0.05
}

describe('loan API', () => {
  beforeEach(async () => {
    // Every test gets a fresh copy of the seed data in a temp folder
    dataDir = await mkdtemp(path.join(tmpdir(), 'tredgate-loan-'))
    auditFile = path.join(dataDir, 'audit.log')
    const store = createLoanStore({ filePath: path.join(dataDir, 'loans.json'), seedPath: SEED_FILE })
    await startServer(createLoanApp({ store, logger: pino({ level: 'silent' }), audit: createAuditLog(auditFile), version: '1.2.0' }))
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()))
    })
    await rm(dataDir, { recursive: true, force: true })
  })

  it('reports health with the release version', async () => {
    const { status, body } = await api<{ status: string; version: string; uptimeSeconds: number }>('/health')
    expect(status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.version).toBe('1.2.0')
    expect(typeof body.uptimeSeconds).toBe('number')
  })

  it('lists the seeded loans', async () => {
    const { status, body } = await api<LoanApplication[]>('/loans')
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]).toMatchObject({ id: 'ln-1001', applicantName: 'Amara Ndlovu', status: 'approved' })
  })

  it('creates a loan with pending status and persists it', async () => {
    const created = await api<LoanApplication>('/loans', { method: 'POST', body: JSON.stringify(newLoan) })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ ...newLoan, status: 'pending' })
    expect(created.body.id).toBeDefined()
    expect(created.body.createdAt).toBeDefined()

    const list = await api<LoanApplication[]>('/loans')
    expect(list.body.some(loan => loan.id === created.body.id)).toBe(true)
  })

  it('rejects an invalid loan with 400 and the validation message', async () => {
    const { status, body } = await api<ErrorBody>('/loans', {
      method: 'POST',
      body: JSON.stringify({ ...newLoan, amount: -5 })
    })
    expect(status).toBe(400)
    expect(body.error).toBe('Amount must be a number greater than 0')
  })

  it('rejects an amount sent as a string', async () => {
    const { status } = await api<ErrorBody>('/loans', {
      method: 'POST',
      body: JSON.stringify({ ...newLoan, amount: '25000' })
    })
    expect(status).toBe(400)
  })

  it('rejects a request without a JSON body with 400', async () => {
    // No Content-Type header: express.json() leaves req.body undefined
    const response = await fetch(`${baseUrl}/api/loans`, { method: 'POST', body: 'applicantName=Alice' })
    const body = (await response.json()) as ErrorBody
    expect(response.status).toBe(400)
    expect(body.error).toBe('Request body must be a JSON object')
  })

  it('rejects malformed JSON with 400', async () => {
    const { status } = await api<ErrorBody>('/loans', { method: 'POST', body: '{ not json' })
    expect(status).toBe(400)
  })

  it('approves a pending loan', async () => {
    const { status, body } = await api<LoanApplication>('/loans/ln-1003/status', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' })
    })
    expect(status).toBe(200)
    expect(body.status).toBe('approved')
  })

  it('rejects an unknown status value with 400', async () => {
    const { status, body } = await api<ErrorBody>('/loans/ln-1003/status', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'maybe' })
    })
    expect(status).toBe(400)
    expect(body.error).toContain('Status must be')
  })

  it('returns 404 for a loan that does not exist', async () => {
    const { status, body } = await api<ErrorBody>('/loans/does-not-exist/status', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' })
    })
    expect(status).toBe(404)
    expect(body.error).toBe('Loan with id does-not-exist not found')
  })

  it('returns 409 when a decided loan is approved again', async () => {
    // ln-1001 is already approved in the seed
    const { status, body } = await api<ErrorBody>('/loans/ln-1001/status', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'rejected' })
    })
    expect(status).toBe(409)
    expect(body.error).toBe('Loan with id ln-1001 has already been decided (approved)')
  })

  it('returns 409 when auto-deciding a decided loan', async () => {
    const { status } = await api<ErrorBody>('/loans/ln-1002/auto-decide', { method: 'POST' })
    expect(status).toBe(409)
  })

  it('auto-decides: approves a loan within the limits', async () => {
    // ln-1004: amount 100000, term 60 (exactly at the limits)
    const { status, body } = await api<LoanApplication>('/loans/ln-1004/auto-decide', { method: 'POST' })
    expect(status).toBe(200)
    expect(body.status).toBe('approved')
  })

  it('auto-decides: rejects a loan above the limits', async () => {
    const created = await api<LoanApplication>('/loans', {
      method: 'POST',
      body: JSON.stringify({ ...newLoan, amount: 150000, termMonths: 72 })
    })
    const { body } = await api<LoanApplication>(`/loans/${created.body.id}/auto-decide`, { method: 'POST' })
    expect(body.status).toBe('rejected')
  })

  it('calculates installments with a full schedule', async () => {
    const { status, body } = await api<InstallmentResult>('/installments/calculate', {
      method: 'POST',
      body: JSON.stringify({ ...newLoan, requestedAt: '2026-10-05T06:30:00.000Z' })
    })
    expect(status).toBe(200)
    expect(body.monthlyPayment).toBe(2187.5)
    expect(body.schedule).toHaveLength(12)
    expect(body.schedule[0]?.dueDate).toBe('2026-11-05')
    expect(body.schedule.at(-1)?.balance).toBe(0)
  })

  it('rejects an invalid installment request with 400', async () => {
    const { status, body } = await api<ErrorBody>('/installments/calculate', {
      method: 'POST',
      body: JSON.stringify({ ...newLoan, interestRate: 8 })
    })
    expect(status).toBe(400)
    expect(body.error).toContain('Interest rate must be between 0 and 1')
  })

  it('writes one audit line per decision', async () => {
    await api('/loans/ln-1003/status', { method: 'PATCH', body: JSON.stringify({ status: 'rejected' }) })
    await api('/loans/ln-1004/auto-decide', { method: 'POST' })
    const lines = (await readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ loanId: 'ln-1003', decision: 'rejected' })
    expect(lines[1]).toMatchObject({ loanId: 'ln-1004', decision: 'approved' })
    expect(lines[0].time).toBeDefined()
    expect(lines[0].reqId).toMatch(/^[0-9a-f]{8}$/)
  })

  it('does not save a decision when the audit trail cannot be written', async () => {
    // Point the audit file inside a path that is a file, so the append fails like a read-only folder would
    await server.close()
    const blocker = path.join(dataDir, 'blocked')
    await writeFile(blocker, 'not a folder')
    const store = createLoanStore({ filePath: path.join(dataDir, 'loans.json'), seedPath: SEED_FILE })
    const brokenAudit = createAuditLog(path.join(blocker, 'audit.log'))
    await startServer(createLoanApp({ store, logger: pino({ level: 'silent' }), audit: brokenAudit }))

    const { status, body } = await api<ErrorBody>('/loans/ln-1003/status', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' })
    })
    expect(status).toBe(500)
    expect(body.error).toContain(`open '${path.join(blocker, 'audit.log')}'`)

    const list = await api<LoanApplication[]>('/loans')
    expect(list.body.find(loan => loan.id === 'ln-1003')?.status).toBe('pending')
  })

  it('keeps working from memory when persistence is disabled', async () => {
    await server.close()
    const store = await createMemoryLoanStore(SEED_FILE)
    await startServer(createLoanApp({ store, logger: pino({ level: 'silent' }) }))

    const created = await api<LoanApplication>('/loans', { method: 'POST', body: JSON.stringify(newLoan) })
    expect(created.status).toBe(201)
    const list = await api<LoanApplication[]>('/loans')
    expect(list.body).toHaveLength(7)
    expect(list.body.some(loan => loan.id === created.body.id)).toBe(true)
  })

  it('returns 404 JSON for unknown API routes', async () => {
    const { status, body } = await api<ErrorBody>('/nope')
    expect(status).toBe(404)
    expect(body.error).toContain('not found')
  })
})
