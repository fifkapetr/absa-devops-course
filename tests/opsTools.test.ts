// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { keyValues, parseDockerfile } from '../ops/tools/lib/dockerfile'
import { parseLine, redact } from '../ops/tools/lib/logFormats'
import { createRng, hex } from '../ops/tools/lib/random'
import { envEntries, mapping, parseYaml, scalar, sequence } from '../ops/tools/lib/yaml'

describe('ops tools: log formats', () => {
  it('parses a prefixed pino line', () => {
    const line = 'loan-api | {"level":50,"time":"2026-10-05T07:12:01.004Z","reqId":"3f9c1a72","status":500,"msg":"request failed with an unexpected error"}'
    expect(parseLine(line)).toMatchObject({ service: 'loan-api', level: 50, time: '2026-10-05T07:12:01.004Z', status: 500, kind: 'pino' })
  })

  it('parses an nginx access line and converts the time to UTC', () => {
    const line = 'gateway | 10.20.0.14 - - [05/Oct/2026:09:12:01 +0200] "GET /api/loans HTTP/1.1" 502 157 "-" "Mozilla/5.0"'
    const parsed = parseLine(line)
    expect(parsed).toMatchObject({ service: 'gateway', level: 50, status: 502, msg: 'GET /api/loans', kind: 'nginx-access' })
    expect(parsed.time).toBe('2026-10-05T07:12:01.000Z')
  })

  it('parses an nginx error line and a docker event', () => {
    const error = parseLine('gateway | 2026/10/05 07:12:03 [error] 29#29: *812 connect() failed (111: Connection refused) while connecting to upstream, client: 10.20.0.14, server: , request: "GET /api/loans HTTP/1.1", upstream: "http://172.18.0.3:3000/api/loans"')
    expect(error).toMatchObject({ service: 'gateway', level: 50, kind: 'nginx-error', time: '2026-10-05T07:12:03.000Z' })
    expect(error.msg).toContain('connect() failed (111: Connection refused)')
    const event = parseLine('docker | 2026-10-05T07:12:00.512Z container oom 3f9c1a72e1 (image=tredgate-loan-api, name=tredgate-loan-api-1)')
    expect(event).toMatchObject({ service: 'docker', level: 50, msg: 'container oom', kind: 'docker' })
  })

  it('redacts applicant names, e-mails and tokens', () => {
    expect(redact('{"request":{"applicantName":"Adela Prochazka","amount":5}} eva.horakova@example.com /docs/reindex?token=FAKE-docs-admin-7f3a&k=1'))
      .toBe('{"request":{"applicantName":"[REDACTED]","amount":5}} [REDACTED-EMAIL] /docs/reindex?token=[REDACTED]&k=1')
  })
})

describe('ops tools: compose and Dockerfile readers', () => {
  it('reads services, lists, flow sequences and comments', () => {
    const doc = parseYaml(`services:
  gateway:
    image: nginx:1.27-alpine   # pinned
    ports:
      - "8080:8080"
  loan-api:
    privileged: true
    environment:
      DATA_FILE: /data/loans.json
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
volumes:
  loan-data: {}
`)
    const services = mapping(mapping(doc).services)
    expect(Object.keys(services)).toEqual(['gateway', 'loan-api'])
    expect(scalar(mapping(services.gateway).image)).toBe('nginx:1.27-alpine')
    expect(sequence(mapping(services.gateway).ports).map(p => scalar(p))).toEqual(['8080:8080'])
    expect(scalar(mapping(services['loan-api']).privileged)).toBe('true')
    expect(mapping(services['loan-api']).privileged?.line).toBe(7)
    expect(envEntries(mapping(services['loan-api']).environment)).toEqual([['DATA_FILE', '/data/loans.json', 9]])
    expect(sequence(mapping(mapping(services['loan-api']).healthcheck).test).map(p => scalar(p))).toContain('http://localhost:3000/api/health')
    expect(Object.keys(mapping(mapping(doc).volumes))).toEqual(['loan-data'])
  })

  it('resolves ARG defaults in FROM and finds the runtime stage', () => {
    const file = parseDockerfile(`ARG BASE_IMAGE=node:latest
FROM \${BASE_IMAGE} AS build
RUN npm ci \\
    && npm run build
FROM node:22-alpine
USER node
ENV DOCS_ADMIN_TOKEN=FAKE-docs-admin-7f3a
`)
    expect(file.stages.map(s => s.from)).toEqual(['node:latest', 'node:22-alpine'])
    expect(file.stages[0]?.alias).toBe('build')
    expect(file.stages[1]?.instructions.map(i => i.name)).toEqual(['USER', 'ENV'])
    expect(keyValues(file.stages[1]!.instructions[1]!)).toEqual([['DOCS_ADMIN_TOKEN', 'FAKE-docs-admin-7f3a']])
    expect(file.instructions[2]).toMatchObject({ name: 'RUN', line: 3 })
  })
})

describe('ops tools: seeded random', () => {
  it('is deterministic for a seed', () => {
    const a = createRng(7)
    const b = createRng(7)
    expect([a.int(1, 100), a.next(), hex(a, 8)]).toEqual([b.int(1, 100), b.next(), hex(b, 8)])
  })
})
