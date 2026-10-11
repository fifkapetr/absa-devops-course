import { copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { parseCli } from './lib/cli'

parseCli('npm run setup', 'Creates .env from .env.example when no .env exists yet. Nothing else is touched.', {})

const root = path.resolve(import.meta.dirname, '..', '..')
const example = path.join(root, '.env.example')
const target = path.join(root, '.env')

if (!existsSync(example)) {
  console.error(`setup: ${example} not found; nothing to copy`)
  process.exit(1)
}
if (existsSync(target)) {
  console.log(`setup: .env already exists, left unchanged (${target})`)
} else {
  copyFileSync(example, target)
  console.log(`setup: created .env from .env.example (${target}). Edit the values before running the pilot.`)
}
