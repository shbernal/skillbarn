#!/usr/bin/env node
/**
 * A stand-in for the `clawhub` CLI, placed earlier on PATH than the real one.
 *
 * The seam skillbarn is tested through is PATH, not dependency injection: this binary
 * exercises the real subprocess code end to end, and can be told to misbehave in ways
 * the live registry cannot be asked to reproduce on demand.
 *
 * Configured entirely by environment:
 *   FAKE_CLAWHUB_FIXTURES  directory of `@owner/slug/{inspect.json,files/**}`
 *   FAKE_CLAWHUB_MODE      ok | empty | partial-crash | bad-hash | install-fails
 *   FAKE_CLAWHUB_LOG       optional file; one JSON line per invocation
 */
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'

const VERSION = '0.23.1-fake'

const argv = process.argv.slice(2)
const fixtures = process.env.FAKE_CLAWHUB_FIXTURES
const mode = process.env.FAKE_CLAWHUB_MODE ?? 'ok'
const logFile = process.env.FAKE_CLAWHUB_LOG

if (logFile) appendFileSync(logFile, `${JSON.stringify(argv)}\n`)

function die(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

/** Mirrors clawhub's own flag layout: globals first, then the subcommand. */
function parse(args) {
  const globals = { workdir: process.cwd(), dir: 'skills' }
  let i = 0
  for (; i < args.length; i++) {
    if (args[i] === '--workdir') globals.workdir = args[++i]
    else if (args[i] === '--dir') globals.dir = args[++i]
    else break
  }
  const [command, ...rest] = args.slice(i)
  const positionals = []
  const options = {}
  for (let j = 0; j < rest.length; j++) {
    if (rest[j] === '--version') options.version = rest[++j]
    else if (rest[j].startsWith('--')) options[rest[j].slice(2)] = true
    else positionals.push(rest[j])
  }
  return { globals, command, positionals, options }
}

function listFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out.sort()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function resolveRef(ref) {
  if (!fixtures) die('FAKE_CLAWHUB_FIXTURES is not set')
  if (ref.startsWith('@')) {
    const [owner, slug] = [ref.slice(1, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)]
    if (!existsSync(join(fixtures, `@${owner}`, slug))) die(`skill not found: ${ref}`)
    return { owner, slug }
  }
  const matches = readdirSync(fixtures)
    .filter((owner) => owner.startsWith('@') && existsSync(join(fixtures, owner, ref)))
    .map((owner) => `${owner}/${ref}`)
  if (matches.length === 0) die(`skill not found: ${ref}`)
  if (matches.length > 1) {
    die(`Multiple skills named "${ref}":\n${matches.map((m) => `  ${m}`).join('\n')}\nSpecify one.`)
  }
  const only = matches[0]
  return { owner: only.slice(1, only.indexOf('/')), slug: ref }
}

function fixtureDir(ref) {
  return join(fixtures, `@${ref.owner}`, ref.slug)
}

/**
 * The `files` manifest is recomputed from the fixture bytes rather than stored, so a
 * re-recorded fixture can never disagree with itself — except in `bad-hash` mode,
 * which is the point of that mode.
 */
function fileManifest(ref) {
  const dir = join(fixtureDir(ref), 'files')
  return listFiles(dir).map((path) => {
    const bytes = readFileSync(join(dir, ...path.split('/')))
    const digest =
      mode === 'bad-hash' && path === 'SKILL.md' ? sha256('not what we served') : sha256(bytes)
    return { path, size: bytes.length, sha256: digest, contentType: 'text/markdown' }
  })
}

const { globals, command, positionals, options } = parse(argv)

if (argv[0] === '-V' || argv[0] === '--cli-version') {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

if (command === 'inspect') {
  const ref = resolveRef(positionals[0])
  const template = JSON.parse(readFileSync(join(fixtureDir(ref), 'inspect.json'), 'utf8'))
  template.version.files = fileManifest(ref)
  if (options.version) {
    template.version.version = options.version
    template.latestVersion = template.latestVersion ?? {}
  }
  process.stdout.write(`${JSON.stringify(template)}\n`)
  process.exit(0)
}

if (command === 'install') {
  const ref = resolveRef(positionals[0])
  const target = join(globals.workdir, globals.dir, `@${ref.owner}`, ref.slug)

  // The real CLI writes its lockfile at <workdir>/.clawhub/ unconditionally. That is
  // exactly why skillbarn installs into a staging workdir outside the project.
  mkdirSync(join(globals.workdir, '.clawhub'), { recursive: true })
  writeFileSync(
    join(globals.workdir, '.clawhub', 'lock.json'),
    `${JSON.stringify({ skills: { [`@${ref.owner}/${ref.slug}`]: { version: options.version ?? '1.0.0' } } }, null, 2)}\n`,
  )

  if (mode === 'install-fails') die(`install failed for @${ref.owner}/${ref.slug}`)
  if (mode === 'empty') process.exit(0) // reports success, writes nothing

  if (mode === 'partial-crash') {
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), '---\nname: partial\n---\ninterrupted\n')
    die('interrupted', 130)
  }

  cpSync(join(fixtureDir(ref), 'files'), target, { recursive: true })

  // ClawHub rewrites _meta.json locally, which is why the digest excludes it.
  if (existsSync(join(target, '_meta.json'))) {
    const meta = JSON.parse(readFileSync(join(target, '_meta.json'), 'utf8'))
    meta.ownerId = 'local-rewrite'
    meta.publishedAt = 1700000000000
    writeFileSync(join(target, '_meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  }
  mkdirSync(join(target, '.clawhub'), { recursive: true })
  writeFileSync(
    join(target, '.clawhub', 'origin.json'),
    `${JSON.stringify({ slug: ref.slug, installedVersion: options.version ?? '1.0.0', fingerprint: 'unverified' }, null, 2)}\n`,
  )
  process.stdout.write(`installed @${ref.owner}/${ref.slug}\n`)
  process.exit(0)
}

die(`fake clawhub: unsupported command ${command ?? '(none)'}`, 2)
