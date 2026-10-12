import { copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { displayPath, parseCli } from './lib/cli'

/**
 * npm run setup
 *
 * First step after `npm install`: creates the local configuration file `.env` by copying the
 * committed template `.env.example`. The app, the container pilot (compose.yaml) and some tools
 * read their settings (ports, file paths, tokens) from `.env`.
 *
 * Safe to run any number of times: an existing `.env` is never overwritten, so your own
 * values survive. To start over, delete `.env` and run the command again.
 *
 * Usage:
 *   npm run setup
 *   npx tsx ops/tools/setup.ts
 *
 * Exit codes: 0 when `.env` exists afterwards (created now or already there),
 *             1 when `.env.example` is missing and there is nothing to copy.
 */
parseCli('npm run setup', 'Creates .env from .env.example when no .env exists yet. Nothing else is touched.', {})

// Paths are built from the location of this script (ops/tools/), not from the current
// working directory, so the command works from any folder inside the repository.
const root = path.resolve(import.meta.dirname, '..', '..')
const example = path.join(root, '.env.example')
const target = path.join(root, '.env')

if (!existsSync(example)) {
  console.error(`setup: ${displayPath(example)} not found; nothing to copy`)
  process.exit(1)
}
if (existsSync(target)) {
  console.log(`setup: .env already exists, left unchanged (${displayPath(target)})`)
} else {
  copyFileSync(example, target)
  console.log(`setup: created .env from .env.example (${displayPath(target)}). Edit the values before running the pilot.`)
}
