/**
 * Move the freshly built packages from .build/ into packages/.
 *   node tools/place-built.mjs
 * Kept separate from the build so the build itself stays workspace-agnostic.
 */
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pairs = [
  [join(ROOT, '.build', 'core'), join(ROOT, 'packages', 'dsh-memory')],
]
for (const [from, to] of pairs) {
  if (!existsSync(from)) {
    console.error('missing build output: ' + from)
    process.exit(1)
  }
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
  console.log('placed ' + to)
}
rmSync(join(ROOT, '.build'), { recursive: true, force: true })
