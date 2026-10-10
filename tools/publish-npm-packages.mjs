/**
 * Publish the DSH memory plugin packages to npm.
 *
 *   node tools/publish-npm-packages.mjs --scope <npm-scope> [--version 0.1.0]
 *        [--credential npm-myself-use] [--token-file <npmrc-or-token-file>] [--dry-run]
 *
 * Token handling (never through argv or the transcript):
 *   default      pull the token from the DevCred vault into a temp file via
 *                `devcred inject -- dc-run.exe --out …`, build a private .npmrc
 *                from it, publish, then delete both
 *   --token-file use an existing npmrc/token file (must contain _authToken=…)
 *
 * Pre-flight runs `npm whoami`; a failure aborts before anything is published.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : fallback
}
const SCOPE_ARG = typeof arg('scope', '') === 'string' ? arg('scope', '') : ''
const VERSION = typeof arg('version', '0.1.0') === 'string' ? arg('version', '0.1.0') : '0.1.0'
const CREDENTIAL = typeof arg('credential', 'npm-myself-use') === 'string' ? arg('credential', 'npm-myself-use') : 'npm-myself-use'
const REPO = typeof arg('repo', '') === 'string' ? arg('repo', '') : ''
const TOKEN_FILE = typeof arg('token-file', '') === 'string' ? arg('token-file', '') : ''
const DRY_RUN = arg('dry-run', false) === true
if (!SCOPE_ARG) {
  console.error('usage: node tools/publish-npm-packages.mjs --scope <npm-scope> [--version x.y.z] [--dry-run]')
  process.exit(2)
}
const SCOPE = SCOPE_ARG.startsWith('@') ? SCOPE_ARG : `@${SCOPE_ARG}`
const NODE = process.execPath
const NPM_CLI = join(dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js')
if (!existsSync(NPM_CLI)) {
  console.error(`npm CLI not found at ${NPM_CLI}`)
  process.exit(2)
}

const work = join(tmpdir(), 'dsh-memory-publish')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const npmrc = join(work, '.npmrc')
const tokenFile = join(work, 'token.txt')
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  rmSync(work, { recursive: true, force: true })
}
process.on('exit', cleanup)

/** Materialise the token into a private .npmrc without printing it. */
function prepareNpmrc() {
  if (TOKEN_FILE) {
    const text = readFileSync(TOKEN_FILE, 'utf8')
    const m = text.match(/:\s*_authToken\s*=\s*(\S+)/) ?? text.match(/^\s*(\S{20,})\s*$/)
    if (!m) throw new Error(`${TOKEN_FILE} carries no _authToken and no bare token`)
    writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${m[1]}\n`, 'ascii')
    console.log(`token source: file (${m[1].length} chars)`)
    return
  }
  const skill = join(process.env.USERPROFILE ?? '', '.dsh', 'skills', 'use-devcred')
  const conf = join(skill, 'devcred-agent.conf')
  const dcRun = join(skill, 'dc-run.exe')
  if (!existsSync(conf) || !existsSync(dcRun)) throw new Error('devcred skill files not found; pass --token-file instead')
  const token = readFileSync(conf, 'utf8').match(/^token=(\S+)\s*$/m)?.[1]
  if (!token) throw new Error('no token= line in devcred-agent.conf')
  const dc = process.env.DEVCRED_BIN ?? 'devcred'
  const res = spawnSync(dc, ['inject', '--only', CREDENTIAL, '--', dcRun, '--env', 'NPM_TOKEN', '--out', tokenFile, '--out-env', 'NPM_TOKEN'], {
    encoding: 'utf8',
    env: { ...process.env, DEVCRED_PASSWORD: token },
  })
  if (res.status !== 0 || !existsSync(tokenFile)) {
    throw new Error(`devcred inject failed (exit ${res.status}): ${(res.stderr || res.stdout || '').trim().slice(0, 300)}`)
  }
  const value = readFileSync(tokenFile, 'utf8').trim()
  rmSync(tokenFile, { force: true })
  writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${value}\n`, 'ascii')
  console.log(`token source: devcred vault (${CREDENTIAL}, ${value.length} chars)`)
}

function npm(args, opts = {}) {
  return spawnSync(NODE, [NPM_CLI, ...args, '--userconfig', npmrc, '--registry', 'https://registry.npmjs.org'], {
    encoding: 'utf8',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, npm_config_loglevel: 'warn' },
  })
}

try {
  prepareNpmrc()

  const who = npm(['whoami'])
  const user = (who.stdout ?? '').trim()
  if (who.status !== 0 || !user) {
    console.error(`npm whoami failed (exit ${who.status}) — the token is not usable: ${(who.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`)
    process.exit(1)
  }
  console.log(`authenticated as: ${user}`)

  console.log(`\nbuilding packages for scope ${SCOPE} version ${VERSION} …`)
  const buildArgs = [join(HERE, 'build-npm-packages.mjs'), '--scope', SCOPE, '--version', VERSION]
  if (REPO) buildArgs.push('--repo', REPO)
  const build = spawnSync(NODE, buildArgs, { encoding: 'utf8', cwd: ROOT })
  process.stdout.write(build.stdout ?? '')
  if (build.status !== 0) {
    console.error(build.stderr ?? '')
    process.exit(1)
  }

  const packages = [
    { dir: join(ROOT, 'dist-npm', 'core'), name: `${SCOPE}/dsh-memory` },
    { dir: join(ROOT, 'dist-npm', 'panel'), name: `${SCOPE}/dsh-memory-panel` },
  ]

  for (const pkg of packages) {
    const meta = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8'))
    if (meta.name !== pkg.name) throw new Error(`built package name mismatch: ${meta.name} != ${pkg.name}`)

    const packArgs = ['pack', '--json', '--pack-destination', work]
    const packed = spawnSync(NODE, [NPM_CLI, ...packArgs], { encoding: 'utf8', cwd: pkg.dir })
    if (packed.status !== 0) throw new Error(`npm pack failed for ${pkg.name}: ${(packed.stderr ?? '').trim()}`)
    const info = JSON.parse((packed.stdout ?? '[]').trim() || '[]')[0]
    console.log(`\n${pkg.name}@${meta.version}: ${info?.entryCount ?? '?'} files, ${((info?.size ?? 0) / 1024).toFixed(1)} KiB packed`)

    if (DRY_RUN) {
      console.log('  (dry run: not publishing)')
      continue
    }
    const pub = npm(['publish', '--access', 'public'], { cwd: pkg.dir })
    process.stdout.write(pub.stdout ?? '')
    if (pub.status !== 0) {
      console.error(pub.stderr ?? '')
      throw new Error(`npm publish failed for ${pkg.name} (exit ${pub.status})`)
    }
    console.log(`  published ${pkg.name}@${meta.version}`)
  }
  console.log(DRY_RUN ? '\nDRY RUN OK' : '\nPUBLISH OK')
} catch (error) {
  console.error(`\nFAILED: ${error.message}`)
  process.exit(1)
} finally {
  cleanup()
}
