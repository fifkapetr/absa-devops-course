import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseCli } from './lib/cli'
import { keyValues, parseDockerfile, type Stage } from './lib/dockerfile'
import { envEntries, mapping, parseYaml, scalar, sequence, type YamlNode } from './lib/yaml'

/**
 * npm run ops:verify
 *
 * Static checks of the container pilot files (OPS-001 to OPS-011, see .github/ops-review-checklist.md).
 * Reads Dockerfiles, .dockerignore and compose.yaml as text; no container engine is needed.
 * One line per rule and subject: PASS/WARN/FAIL OPS-0xx <description> (<file>:<line>), then a summary.
 * Exit code 1 when any rule FAILs.
 */
const { values } = parseCli(
  'npm run ops:verify',
  'Checks Dockerfiles, .dockerignore and compose.yaml against the OPS-001..011 rules without a container engine.',
  {
    path: { type: 'string', default: '.', description: 'Folder that holds compose.yaml and the Dockerfiles (or a docker/ subfolder)' }
  }
)

type Verdict = 'PASS' | 'WARN' | 'FAIL'
interface Finding {
  verdict: Verdict
  rule: string
  text: string
  file: string
  line?: number
}

const root = path.resolve(values.path)
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|KEY/i
const findings: Finding[] = []

function report(verdict: Verdict, rule: string, text: string, file: string, line?: number) {
  findings.push({ verdict, rule, text, file: path.relative(process.cwd(), file) || '.', line })
}

// ---------------------------------------------------------------- discover files
function findDockerfiles(): string[] {
  const candidates: string[] = []
  for (const dir of [root, path.join(root, 'docker')]) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (/dockerfile/i.test(name) && !name.endsWith('.dockerignore')) candidates.push(path.join(dir, name))
    }
  }
  return candidates.sort()
}

function findCompose(): string | undefined {
  return ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
    .map(name => path.join(root, name))
    .find(file => existsSync(file))
}

const dockerfiles = findDockerfiles()
const composeFile = findCompose()
const compose = composeFile ? parseYaml(readFileSync(composeFile, 'utf8')) : undefined
const services = mapping(mapping(compose).services)
const namedVolumes = Object.keys(mapping(mapping(compose).volumes))

if (dockerfiles.length === 0) report('FAIL', 'OPS-000', 'no Dockerfile found', root)
if (!composeFile) report('FAIL', 'OPS-000', 'no compose.yaml found', root)

// Which Dockerfile does a service build from?
function dockerfileOf(service: YamlNode): string | undefined {
  const build = mapping(service).build
  if (!build) return undefined
  const name = path.basename(scalar(mapping(build).dockerfile) ?? 'Dockerfile')
  return dockerfiles.find(file => path.basename(file) === name) ?? dockerfiles.find(file => path.basename(file).toLowerCase() === name.toLowerCase())
}

const parsed = new Map(dockerfiles.map(file => [file, parseDockerfile(readFileSync(file, 'utf8'))]))

function runtimeStage(file: string): Stage | undefined {
  return parsed.get(file)?.stages.at(-1)
}

function runtimeUser(file: string): { user?: string; line?: number } {
  const stage = runtimeStage(file)
  const user = stage?.instructions.filter(i => i.name === 'USER').at(-1)
  return { user: user?.args.split(':')[0], line: user?.line }
}

function isRoot(user?: string): boolean {
  return !user || user === 'root' || user === '0'
}

// ---------------------------------------------------------------- OPS-001 base images
function checkImageRef(ref: string, file: string, line: number, what: string) {
  const stageNames = new Set(parsed.get(file)?.stages.map(stage => stage.alias).filter(Boolean))
  if (stageNames.has(ref)) return // FROM <earlier stage>
  if (ref === 'scratch') return
  const [nameAndTag, digest] = ref.split('@')
  const lastSlash = nameAndTag!.lastIndexOf('/')
  const tag = nameAndTag!.slice(lastSlash + 1).includes(':') ? nameAndTag!.split(':').pop() : undefined
  if (!tag || tag === 'latest') {
    report('FAIL', 'OPS-001', `${what} ${ref || '<empty>'} uses latest or no tag; pin a version`, file, line)
  } else if (!digest) {
    report('WARN', 'OPS-001', `${what} ${ref} pins a tag but no digest`, file, line)
  } else {
    report('PASS', 'OPS-001', `${what} ${nameAndTag} pinned by digest`, file, line)
  }
}

for (const file of dockerfiles) {
  for (const stage of parsed.get(file)!.stages) checkImageRef(stage.from, file, stage.fromLine, 'FROM')
}
for (const [name, service] of Object.entries(services)) {
  const image = mapping(service).image
  if (image && !mapping(service).build) checkImageRef(scalar(image) ?? '', composeFile!, image.line, `image of ${name}`)
}

// ---------------------------------------------------------------- OPS-002 non-root user
for (const file of dockerfiles) {
  const { user, line } = runtimeUser(file)
  if (isRoot(user)) report('FAIL', 'OPS-002', `runtime stage has no non-root USER (runs as root)`, file, line ?? runtimeStage(file)?.fromLine)
  else report('PASS', 'OPS-002', `runtime stage runs as USER ${user}`, file, line)
}

// ---------------------------------------------------------------- OPS-003 secrets baked into images
for (const file of dockerfiles) {
  let found = false
  for (const instruction of parsed.get(file)!.instructions) {
    if (instruction.name !== 'ENV' && instruction.name !== 'ARG') continue
    for (const [key, value] of keyValues(instruction)) {
      if (SECRET_NAME.test(key) && value && !/^\$\{?[A-Z_]+\}?$/.test(value)) {
        found = true
        report('FAIL', 'OPS-003', `${instruction.name} ${key} has a literal value baked into the image`, file, instruction.line)
      }
    }
  }
  if (!found) report('PASS', 'OPS-003', 'no ENV/ARG named like TOKEN, SECRET, PASSWORD or KEY with a literal value', file)
}

// ---------------------------------------------------------------- OPS-004 .dockerignore
{
  const contexts = Object.values(services)
    .map(service => scalar(mapping(mapping(service).build).context))
    .filter((context): context is string => Boolean(context))
    .map(context => path.resolve(path.dirname(composeFile ?? root), context))
  const candidates = [root, ...contexts].map(dir => path.join(dir, '.dockerignore'))
  const ignoreFile = candidates.find(file => existsSync(file))
  if (!ignoreFile) {
    report('FAIL', 'OPS-004', `.dockerignore missing (looked in ${[...new Set(candidates.map(c => path.relative(process.cwd(), path.dirname(c)) || '.'))].join(', ')}); the build context includes .env, .git and node_modules`, candidates[0]!)
  } else {
    const entries = readFileSync(ignoreFile, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    const missing = ['.env', '.git', 'node_modules'].filter(required => !entries.some(entry => entry === required || entry === `${required}/` || entry === `**/${required}` || (required === '.env' && /^\.env\*?$/.test(entry))))
    if (missing.length) report('FAIL', 'OPS-004', `.dockerignore does not exclude ${missing.join(', ')}`, ignoreFile)
    else report('PASS', 'OPS-004', '.dockerignore excludes .env, .git and node_modules', ignoreFile)
  }
}

// ---------------------------------------------------------------- OPS-005 healthchecks
function healthcheckText(service: YamlNode): { text: string; file: string; line: number } | undefined {
  const inCompose = mapping(service).healthcheck
  if (inCompose) {
    const test = mapping(inCompose).test
    const text = Array.isArray(test?.value) ? sequence(test).map(item => scalar(item) ?? '').join(' ') : (scalar(test) ?? '')
    if (scalar(mapping(inCompose).disable) === 'true' || text.trim() === 'NONE') return undefined
    return { text, file: composeFile!, line: inCompose.line }
  }
  const file = dockerfileOf(service)
  const instruction = file ? runtimeStage(file)?.instructions.find(i => i.name === 'HEALTHCHECK') : undefined
  if (file && instruction && !/^NONE$/i.test(instruction.args)) return { text: instruction.args, file, line: instruction.line }
  return undefined
}

for (const name of ['loan-api', 'docs-search']) {
  const service = services[name]
  if (!service) {
    if (composeFile) report('WARN', 'OPS-005', `service ${name} not found in compose file`, composeFile)
    continue
  }
  const check = healthcheckText(service)
  if (!check) {
    report('FAIL', 'OPS-005', `${name} has no healthcheck (Dockerfile HEALTHCHECK or compose healthcheck)`, composeFile!, service.line)
  } else if (name === 'loan-api' && !/\/api\/(loans|health)\b/.test(check.text)) {
    report('FAIL', 'OPS-005', `loan-api healthcheck must call /api/loans or /api/health, found: ${check.text.trim()}`, check.file, check.line)
  } else {
    report('PASS', 'OPS-005', `${name} has a healthcheck: ${check.text.trim()}`, check.file, check.line)
  }
}

// ---------------------------------------------------------------- OPS-006 published ports
{
  let violations = 0
  for (const [name, service] of Object.entries(services)) {
    const ports = mapping(service).ports
    if (ports && name !== 'gateway') {
      violations++
      report('FAIL', 'OPS-006', `${name} publishes ports ${sequence(ports).map(p => scalar(p)).join(', ')}; only gateway may publish`, composeFile!, ports.line)
    }
  }
  if (!violations && composeFile) report('PASS', 'OPS-006', 'only gateway publishes ports', composeFile, services.gateway?.line)
}

// ---------------------------------------------------------------- OPS-007 .. OPS-010 per service
for (const [name, service] of Object.entries(services)) {
  const fields = mapping(service)

  const privileged = fields.privileged
  if (scalar(privileged) === 'true') report('FAIL', 'OPS-007', `${name} runs privileged`, composeFile!, privileged!.line)
  else report('PASS', 'OPS-007', `${name} is not privileged`, composeFile!, service.line)

  const sock = sequence(fields.volumes).find(volume => (scalar(volume) ?? '').includes('docker.sock'))
  if (sock) report('FAIL', 'OPS-008', `${name} mounts the Docker socket (${scalar(sock)})`, composeFile!, sock.line)
  else report('PASS', 'OPS-008', `${name} does not mount docker.sock`, composeFile!, service.line)

  const literals = envEntries(fields.environment).filter(([key, value]) => SECRET_NAME.test(key) && value && !/^\$\{[^}]+\}$/.test(value))
  if (literals.length) {
    for (const [key, , line] of literals) report('FAIL', 'OPS-009', `${name} has a literal secret ${key} in environment; use \${${key}} or env_file`, composeFile!, line)
  } else {
    report('PASS', 'OPS-009', `${name} has no literal secret in environment`, composeFile!, fields.environment?.line ?? service.line)
  }

  const restart = scalar(fields.restart)
  if (!restart || restart === 'no') report('FAIL', 'OPS-010', `${name} has no restart policy`, composeFile!, service.line)
  else report('PASS', 'OPS-010', `${name} restarts: ${restart}`, composeFile!, fields.restart!.line)
}

// ---------------------------------------------------------------- OPS-011 data path writable by the runtime user
for (const [name, service] of Object.entries(services)) {
  const fields = mapping(service)
  const dataFile = envEntries(fields.environment).find(([key]) => key === 'DATA_FILE')?.[1]
  const volumes = sequence(fields.volumes).map(volume => ({ text: scalar(volume) ?? '', line: volume.line }))
  const dataVolume = volumes.find(volume => volume.text.split(':')[1]?.startsWith('/data') || (dataFile && volume.text.split(':')[1] && dataFile.startsWith(volume.text.split(':')[1]!)))
  if (!dataFile && !dataVolume) continue // service holds no data
  const dataDir = dataFile ? path.posix.dirname(dataFile) : dataVolume!.text.split(':')[1]!
  const file = dockerfileOf(service)
  const { user } = file ? runtimeUser(file) : {}

  if (!file) {
    report('WARN', 'OPS-011', `${name} holds data in ${dataDir} but is not built here; check the image's user and the mount ownership manually`, composeFile!, service.line)
    continue
  }
  if (isRoot(user)) {
    report('PASS', 'OPS-011', `${name} runs as root, so ${dataDir} is writable whatever the mount is (fix OPS-002 first, then re-check)`, composeFile!, dataVolume?.line ?? service.line)
    continue
  }
  const runs = runtimeStage(file)?.instructions.filter(i => i.name === 'RUN' || i.name === 'COPY') ?? []
  const prepares = runs.some(i => i.args.includes(dataDir) && /chown|--chown/.test(i.args) && (/mkdir/.test(i.args) || i.name === 'COPY'))
  if (!prepares) report('FAIL', 'OPS-011', `${name} runs as USER ${user} but the image does not create and chown ${dataDir}; a mounted volume stays root-owned and 1.2.0 starts with "persistence disabled"`, file, runtimeStage(file)?.fromLine)
  if (!dataVolume) {
    report('FAIL', 'OPS-011', `${name} has no volume for ${dataDir}; data is lost with the container`, composeFile!, service.line)
  } else {
    const source = dataVolume.text.split(':')[0]!
    const bind = source.startsWith('.') || source.startsWith('/') || source.startsWith('~') || /^[A-Za-z]:[\\/]/.test(source)
    if (bind) report('FAIL', 'OPS-011', `${name} mounts a bind mount ${source} on ${dataDir}; as USER ${user} a root-owned host folder is read-only for the app (use a named volume)`, composeFile!, dataVolume.line)
    else if (!namedVolumes.includes(source)) report('WARN', 'OPS-011', `${name} uses volume ${source} which is not declared under top-level volumes`, composeFile!, dataVolume.line)
    else if (prepares) report('PASS', 'OPS-011', `${name} runs as USER ${user}, image prepares ${dataDir}, compose uses named volume ${source}`, composeFile!, dataVolume.line)
  }
}

// ---------------------------------------------------------------- output
const order: Record<Verdict, number> = { FAIL: 0, WARN: 1, PASS: 2 }
findings.sort((a, b) => a.rule.localeCompare(b.rule) || order[a.verdict] - order[b.verdict] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
console.log(`ops:verify ${path.relative(process.cwd(), root) || '.'}  (${dockerfiles.length} Dockerfile(s), ${composeFile ? path.basename(composeFile) : 'no compose file'})\n`)
for (const finding of findings) {
  console.log(`${finding.verdict} ${finding.rule} ${finding.text} (${finding.file}${finding.line ? `:${finding.line}` : ''})`)
}
const count = (verdict: Verdict) => findings.filter(f => f.verdict === verdict).length
console.log(`\nsummary: ${count('PASS')} PASS, ${count('WARN')} WARN, ${count('FAIL')} FAIL in ${findings.length} checks`)
process.exit(count('FAIL') ? 1 : 0)
