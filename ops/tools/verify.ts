import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { displayPath, parseCli, resolveInput } from './lib/cli'
import { keyValues, parseDockerfile, type Stage } from './lib/dockerfile'
import { envEntries, mapping, parseYaml, scalar, sequence, type YamlNode } from './lib/yaml'

/**
 * npm run ops:verify
 *
 * Static checks of the container pilot files (OPS-001 to OPS-011, see .github/ops-review-checklist.md).
 * Reads Dockerfiles, .dockerignore and compose.yaml as text; no container engine is needed.
 * One line per rule and subject: PASS/WARN/FAIL OPS-0xx <description> (<file>:<line>), then a summary.
 * Exit code 1 when any rule FAILs.
 *
 * Usage:
 *   npx tsx ops/tools/verify.ts                                       the repository root (compose.yaml + docker/)
 *   npx tsx ops/tools/verify.ts --path incident/INC-20261007-01/deploy  any other folder with the same layout
 *   npm run ops:verify -- --path <dir>                                  the same through npm
 *
 * What is checked (the checklist has the reasons behind each rule):
 *   OPS-001  base images (`FROM`, compose `image:`) pin a version tag; a digest is recommended
 *   OPS-002  the runtime stage of every Dockerfile runs as a non-root `USER`
 *   OPS-003  no `ENV`/`ARG` named like TOKEN, SECRET, PASSWORD or KEY with a literal value
 *   OPS-004  `.dockerignore` exists and excludes `.env`, `.git` and `node_modules`
 *   OPS-005  loan-api and docs-search have a healthcheck; loan-api's calls /api/loans or /api/health
 *   OPS-006  only the gateway service publishes ports
 *   OPS-007  no service runs `privileged: true`
 *   OPS-008  no service mounts the Docker socket
 *   OPS-009  no literal secret values in compose `environment`
 *   OPS-010  every service has a `restart` policy
 *   OPS-011  a service that stores data can write its data folder as its runtime user
 *   OPS-000  is not a rule: it reports that a Dockerfile or the compose file was not found at all
 *
 * How to read a line:
 *   FAIL OPS-002 runtime stage has no non-root USER (runs as root) (docker/api.Dockerfile:12)
 *   ^    ^       ^                                                  ^ file and line to open
 *   |    |       what was found
 *   |    rule id from the checklist
 *   PASS = rule met, WARN = worth a look but not blocking, FAIL = must be fixed
 *
 * The checks are pattern matches on text, not a real Docker build. A PASS means "the files look
 * right", not "the container works". Always confirm a fix by reading the file it points to.
 */
const { values } = parseCli(
  'npm run ops:verify',
  'Checks Dockerfiles, .dockerignore and compose.yaml against the OPS-001..011 rules without a container engine.',
  {
    path: { type: 'string', default: '.', description: 'Folder that holds compose.yaml and the Dockerfiles (or a docker/ subfolder)' }
  }
)

/** PASS = rule met, WARN = recommendation, FAIL = rule broken (makes the exit code 1) */
type Verdict = 'PASS' | 'WARN' | 'FAIL'

/** One output line: a verdict for one rule on one subject (a Dockerfile, a service, ...) */
interface Finding {
  verdict: Verdict
  rule: string
  text: string
  file: string
  line?: number
}

const root = resolveInput(values.path)
/** Variable names that look like they hold a secret; matched case-insensitively anywhere in the name */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|KEY/i
const findings: Finding[] = []

/**
 * Record one result. Nothing is printed yet: all findings are collected, sorted by rule and
 * printed together at the end, so the output order does not depend on the order of the checks.
 *
 * @param verdict PASS, WARN or FAIL
 * @param rule    the checklist id, e.g. 'OPS-004'
 * @param text    a short human-readable explanation of what was found
 * @param file    absolute path of the file the finding is about (printed relative to the repository)
 * @param line    1-based line number in that file, when the finding points at a specific line
 */
function report(verdict: Verdict, rule: string, text: string, file: string, line?: number) {
  findings.push({ verdict, rule, text, file: displayPath(file) || '.', line })
}

// ---------------------------------------------------------------- discover files
/**
 * Find the Dockerfiles in the checked folder and in its `docker/` subfolder.
 * Any file with "dockerfile" in its name counts (`Dockerfile`, `api.Dockerfile`, `Dockerfile.docs`),
 * except per-Dockerfile ignore files such as `api.Dockerfile.dockerignore`.
 *
 * @returns absolute paths, sorted so the output is the same on every machine
 */
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

/**
 * Find the compose file using the same names Docker Compose itself looks for, in its order of preference.
 *
 * @returns the absolute path of the first one that exists, or undefined when there is none
 */
function findCompose(): string | undefined {
  return ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
    .map(name => path.join(root, name))
    .find(file => existsSync(file))
}

const dockerfiles = findDockerfiles()
const composeFile = findCompose()
// `mapping()` returns an empty object for a missing node, so the lines below also work when
// there is no compose file or it has no `services:` / `volumes:` section.
const compose = composeFile ? parseYaml(readFileSync(composeFile, 'utf8')) : undefined
const services = mapping(mapping(compose).services)
const namedVolumes = Object.keys(mapping(mapping(compose).volumes))

if (dockerfiles.length === 0) report('FAIL', 'OPS-000', 'no Dockerfile found', root)
if (!composeFile) report('FAIL', 'OPS-000', 'no compose.yaml found', root)

/**
 * Which Dockerfile does a compose service build from?
 * Reads `build.dockerfile` (default `Dockerfile`) and matches it by file name against the
 * Dockerfiles found above, first exactly, then ignoring upper/lower case.
 *
 * @param service the service node from compose.yaml
 * @returns the Dockerfile's absolute path, or undefined for services that use a ready-made `image:`
 */
function dockerfileOf(service: YamlNode): string | undefined {
  const build = mapping(service).build
  if (!build) return undefined
  const name = path.basename(scalar(mapping(build).dockerfile) ?? 'Dockerfile')
  return dockerfiles.find(file => path.basename(file) === name) ?? dockerfiles.find(file => path.basename(file).toLowerCase() === name.toLowerCase())
}

// Each Dockerfile is parsed once into stages and instructions; the checks below only read this map.
const parsed = new Map(dockerfiles.map(file => [file, parseDockerfile(readFileSync(file, 'utf8'))]))

/**
 * The stage that ends up in the final image. In a multi-stage build (several `FROM` lines)
 * only the last stage is shipped; earlier stages (build, test) are thrown away after the build.
 *
 * @param file absolute path of a Dockerfile
 */
function runtimeStage(file: string): Stage | undefined {
  return parsed.get(file)?.stages.at(-1)
}

/**
 * The user the container runs as: the last `USER` instruction of the runtime stage.
 * `USER node:node` is reduced to `node` (the part before the colon is the user, after it the group).
 *
 * @param file absolute path of a Dockerfile
 * @returns the user name and the line of the `USER` instruction; both undefined when there is none
 */
function runtimeUser(file: string): { user?: string; line?: number } {
  const stage = runtimeStage(file)
  const user = stage?.instructions.filter(i => i.name === 'USER').at(-1)
  return { user: user?.args.split(':')[0], line: user?.line }
}

/**
 * Does the container run as root? Without a `USER` instruction it does, because root is Docker's default.
 * `0` is root's numeric user id.
 */
function isRoot(user?: string): boolean {
  return !user || user === 'root' || user === '0'
}

// ---------------------------------------------------------------- OPS-001 base images
/**
 * Check that an image reference pins a version.
 *
 *   node                          FAIL  no tag means `latest`, which changes whenever upstream publishes
 *   node:latest                   FAIL
 *   node:22-alpine                WARN  pinned tag, but a tag can be re-pushed with different content
 *   node:22-alpine@sha256:ab12…   PASS  the digest identifies exactly one image
 *
 * @param ref  the image reference as written in the file
 * @param file the file it comes from (Dockerfile or compose file)
 * @param line the line it is on
 * @param what label for the output, e.g. 'FROM' or 'image of gateway'
 */
function checkImageRef(ref: string, file: string, line: number, what: string) {
  const stageNames = new Set(parsed.get(file)?.stages.map(stage => stage.alias).filter(Boolean))
  if (stageNames.has(ref)) return // FROM <earlier stage>
  if (ref === 'scratch') return // the empty base image, nothing to pin
  const [nameAndTag, digest] = ref.split('@')
  // Only a colon after the last `/` is a tag; in `registry.example:5000/node` the colon belongs to the port.
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

// Every FROM line of every stage is checked, not only the runtime stage.
for (const file of dockerfiles) {
  for (const stage of parsed.get(file)!.stages) checkImageRef(stage.from, file, stage.fromLine, 'FROM')
}
// Compose services with `image:` and no `build:` pull a ready-made image (e.g. the nginx gateway).
for (const [name, service] of Object.entries(services)) {
  const image = mapping(service).image
  if (image && !mapping(service).build) checkImageRef(scalar(image) ?? '', composeFile!, image.line, `image of ${name}`)
}

// ---------------------------------------------------------------- OPS-002 non-root user
for (const file of dockerfiles) {
  const { user, line } = runtimeUser(file)
  // Without a USER line, point at the runtime stage's FROM line so you know which stage to fix.
  if (isRoot(user)) report('FAIL', 'OPS-002', `runtime stage has no non-root USER (runs as root)`, file, line ?? runtimeStage(file)?.fromLine)
  else report('PASS', 'OPS-002', `runtime stage runs as USER ${user}`, file, line)
}

// ---------------------------------------------------------------- OPS-003 secrets baked into images
for (const file of dockerfiles) {
  let found = false
  // All stages are checked, not only the runtime stage.
  for (const instruction of parsed.get(file)!.instructions) {
    if (instruction.name !== 'ENV' && instruction.name !== 'ARG') continue
    for (const [key, value] of keyValues(instruction)) {
      // `ENV API_TOKEN=abc123` fails; `ARG API_TOKEN` (no value) and `ENV API_TOKEN=$API_TOKEN` pass,
      // because the value is supplied at build or run time and is not written into the file.
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
  // Docker reads .dockerignore from the root of the build context, so look in the checked folder
  // and in every `build.context` folder named in compose.yaml (resolved relative to compose.yaml).
  const contexts = Object.values(services)
    .map(service => scalar(mapping(mapping(service).build).context))
    .filter((context): context is string => Boolean(context))
    .map(context => path.resolve(path.dirname(composeFile ?? root), context))
  const candidates = [root, ...contexts].map(dir => path.join(dir, '.dockerignore'))
  const ignoreFile = candidates.find(file => existsSync(file))
  if (!ignoreFile) {
    report('FAIL', 'OPS-004', `.dockerignore missing (looked in ${[...new Set(candidates.map(c => displayPath(path.dirname(c)) || '.'))].join(', ')}); the build context includes .env, .git and node_modules`, candidates[0]!)
  } else {
    // Ignore blank lines and comments, then accept the usual spellings of each entry:
    // `.git`, `.git/`, `**/.git`, and for .env also `.env*`.
    const entries = readFileSync(ignoreFile, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    const missing = ['.env', '.git', 'node_modules'].filter(required => !entries.some(entry => entry === required || entry === `${required}/` || entry === `**/${required}` || (required === '.env' && /^\.env\*?$/.test(entry))))
    if (missing.length) report('FAIL', 'OPS-004', `.dockerignore does not exclude ${missing.join(', ')}`, ignoreFile)
    else report('PASS', 'OPS-004', '.dockerignore excludes .env, .git and node_modules', ignoreFile)
  }
}

// ---------------------------------------------------------------- OPS-005 healthchecks
/**
 * Find the healthcheck command of a service. A `healthcheck:` in compose.yaml wins over a
 * `HEALTHCHECK` in the Dockerfile, the same precedence Docker uses at run time.
 * `disable: true`, `test: NONE` and `HEALTHCHECK NONE` all count as "no healthcheck".
 *
 * @param service the service node from compose.yaml
 * @returns the command text and where it is written, or undefined when the service has none
 */
function healthcheckText(service: YamlNode): { text: string; file: string; line: number } | undefined {
  const inCompose = mapping(service).healthcheck
  if (inCompose) {
    // `test` is either a list (["CMD", "wget", "-q", ...]) or a single string; join the list into one line.
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

// Only the two application services need a healthcheck; gateway and helper containers are not checked.
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
    // A check that only proves the port is open (or calls some other URL) does not count for the API.
    report('FAIL', 'OPS-005', `loan-api healthcheck must call /api/loans or /api/health, found: ${check.text.trim()}`, check.file, check.line)
  } else {
    report('PASS', 'OPS-005', `${name} has a healthcheck: ${check.text.trim()}`, check.file, check.line)
  }
}

// ---------------------------------------------------------------- OPS-006 published ports
{
  // `ports:` makes a container reachable from outside Docker. Services reach each other over the
  // compose network by service name without it, so only the entry point (gateway) needs `ports:`.
  // (`expose:` is fine: it is documentation only and opens nothing to the host.)
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
// Four simple rules that are each checked once per compose service, so they share one loop.
for (const [name, service] of Object.entries(services)) {
  const fields = mapping(service)

  // OPS-007: `privileged: true` gives the container almost all the powers of the host.
  const privileged = fields.privileged
  if (scalar(privileged) === 'true') report('FAIL', 'OPS-007', `${name} runs privileged`, composeFile!, privileged!.line)
  else report('PASS', 'OPS-007', `${name} is not privileged`, composeFile!, service.line)

  // OPS-008: any volume entry mentioning docker.sock (e.g. /var/run/docker.sock:/var/run/docker.sock).
  const sock = sequence(fields.volumes).find(volume => (scalar(volume) ?? '').includes('docker.sock'))
  if (sock) report('FAIL', 'OPS-008', `${name} mounts the Docker socket (${scalar(sock)})`, composeFile!, sock.line)
  else report('PASS', 'OPS-008', `${name} does not mount docker.sock`, composeFile!, service.line)

  // OPS-009: `DOCS_ADMIN_TOKEN: abc123` fails; `DOCS_ADMIN_TOKEN: ${DOCS_ADMIN_TOKEN}` passes because
  // compose fills it in from .env (which is not committed). envEntries() understands both the
  // list form (`- KEY=value`) and the map form (`KEY: value`) of `environment:`.
  const literals = envEntries(fields.environment).filter(([key, value]) => SECRET_NAME.test(key) && value && !/^\$\{[^}]+\}$/.test(value))
  if (literals.length) {
    for (const [key, , line] of literals) report('FAIL', 'OPS-009', `${name} has a literal secret ${key} in environment; use \${${key}} or env_file`, composeFile!, line)
  } else {
    report('PASS', 'OPS-009', `${name} has no literal secret in environment`, composeFile!, fields.environment?.line ?? service.line)
  }

  // OPS-010: `restart: no` is the default and means "never restart"; any other policy passes
  // (always, unless-stopped, on-failure).
  const restart = scalar(fields.restart)
  if (!restart || restart === 'no') report('FAIL', 'OPS-010', `${name} has no restart policy`, composeFile!, service.line)
  else report('PASS', 'OPS-010', `${name} restarts: ${restart}`, composeFile!, fields.restart!.line)
}

// ---------------------------------------------------------------- OPS-011 data path writable by the runtime user
// This rule connects three files: compose.yaml (DATA_FILE and volumes), the Dockerfile (USER and
// the RUN/COPY lines that prepare folders) and the top-level `volumes:` list. It is a heuristic:
// it looks for the patterns described in the checklist, it does not run the container.
for (const [name, service] of Object.entries(services)) {
  const fields = mapping(service)
  // A service "holds data" when it sets DATA_FILE or mounts a volume on /data (or on DATA_FILE's folder).
  // Volume entries look like `source:target[:options]`; split(':')[1] is the path inside the container.
  const dataFile = envEntries(fields.environment).find(([key]) => key === 'DATA_FILE')?.[1]
  const volumes = sequence(fields.volumes).map(volume => ({ text: scalar(volume) ?? '', line: volume.line }))
  const dataVolume = volumes.find(volume => volume.text.split(':')[1]?.startsWith('/data') || (dataFile && volume.text.split(':')[1] && dataFile.startsWith(volume.text.split(':')[1]!)))
  if (!dataFile && !dataVolume) continue // service holds no data
  const dataDir = dataFile ? path.posix.dirname(dataFile) : dataVolume!.text.split(':')[1]!
  const file = dockerfileOf(service)
  const { user } = file ? runtimeUser(file) : {}

  if (!file) {
    // A ready-made image: its Dockerfile is not here, so the user and folder ownership cannot be checked.
    report('WARN', 'OPS-011', `${name} holds data in ${dataDir} but is not built here; check the image's user and the mount ownership manually`, composeFile!, service.line)
    continue
  }
  if (isRoot(user)) {
    report('PASS', 'OPS-011', `${name} runs as root, so ${dataDir} is writable whatever the mount is (fix OPS-002 first, then re-check)`, composeFile!, dataVolume?.line ?? service.line)
    continue
  }
  // Check 1: the image creates the data folder and hands it to the runtime user, e.g.
  //   RUN mkdir -p /data && chown node:node /data      or      COPY --chown=node:node ... /data
  const runs = runtimeStage(file)?.instructions.filter(i => i.name === 'RUN' || i.name === 'COPY') ?? []
  const prepares = runs.some(i => i.args.includes(dataDir) && /chown|--chown/.test(i.args) && (/mkdir/.test(i.args) || i.name === 'COPY'))
  if (!prepares) report('FAIL', 'OPS-011', `${name} runs as USER ${user} but the image does not create and chown ${dataDir}; a mounted volume stays root-owned and 1.2.0 starts with "persistence disabled"`, file, runtimeStage(file)?.fromLine)
  // Check 2: the data folder is on a named volume. A path as source (./data, /srv/data, ~/data,
  // C:\data) is a bind mount of a host folder; a plain name (loan-data) is a Docker-managed named volume.
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
// Sort by rule, then FAIL before WARN before PASS, then by file and line, so problems come first in each rule.
const order: Record<Verdict, number> = { FAIL: 0, WARN: 1, PASS: 2 }
findings.sort((a, b) => a.rule.localeCompare(b.rule) || order[a.verdict] - order[b.verdict] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
console.log(`ops:verify ${displayPath(root) || '.'}  (${dockerfiles.length} Dockerfile(s), ${composeFile ? path.basename(composeFile) : 'no compose file'})\n`)
for (const finding of findings) {
  console.log(`${finding.verdict} ${finding.rule} ${finding.text} (${finding.file}${finding.line ? `:${finding.line}` : ''})`)
}
const count = (verdict: Verdict) => findings.filter(f => f.verdict === verdict).length
console.log(`\nsummary: ${count('PASS')} PASS, ${count('WARN')} WARN, ${count('FAIL')} FAIL in ${findings.length} checks`)
// Exit code 1 lets scripts and CI pipelines stop on a failed check (`npm run ops:verify && docker compose up`).
process.exit(count('FAIL') ? 1 : 0)
