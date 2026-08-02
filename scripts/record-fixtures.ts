#!/usr/bin/env node
/**
 * Re-record `test/fixtures/registry/` from the live ClawHub.
 *
 * Layer 2 replays these fixtures through a fake `clawhub`; this script is how they get
 * refreshed. Running it is a network operation and deliberately manual — the contract
 * tests that call it (part 02) are nightly, never a merge gate, so a registry outage
 * can never fail a PR. Drift shows up as a readable diff in `git status`.
 *
 *   node scripts/record-fixtures.ts @owner/slug [@owner/slug ...]
 *
 * Note on `_meta.json`: the bytes recorded here come from an install, and ClawHub
 * rewrites that file locally. It is excluded from every digest for exactly that reason,
 * so the discrepancy is inert — see src/digest.ts.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  installIntoStaging,
  requireClawhub,
  runClawhub,
  STAGING_SKILLS_DIR,
} from '../src/clawhub.ts'
import { isSkbError, SkbError } from '../src/errors.ts'
import { parseInspectJson } from '../src/inspect.ts'
import { formatSkillRef, isScoped, parseSkillRef } from '../src/slug.ts'

const REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'registry')

const refs = process.argv.slice(2)
if (refs.length === 0) {
  process.stderr.write('usage: node scripts/record-fixtures.ts @owner/slug [...]\n')
  process.exit(2)
}

try {
  process.stderr.write(`clawhub ${await requireClawhub()}\n`)

  for (const input of refs) {
    const requested = parseSkillRef(input)

    // Recorded verbatim: the fake replays ClawHub's own JSON shape, so parsing and
    // re-serialising it here would record skillbarn's view instead of the registry's.
    const run = await runClawhub(['inspect', formatSkillRef(requested), '--files', '--json'])
    if (run.code !== 0) throw new SkbError(`inspect failed for ${input}`, run.stderr.trim())
    const raw = JSON.parse(run.stdout) as { version?: { files?: unknown } }
    const inspected = parseInspectJson(run.stdout)
    const ref = { owner: inspected.owner, slug: inspected.slug }
    if (!isScoped(requested)) {
      process.stderr.write(`resolved ${input} to @${ref.owner}/${ref.slug}\n`)
    }

    const target = join(REGISTRY, `@${ref.owner}`, ref.slug)
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })

    const staging = await mkdtemp(join(tmpdir(), 'skillbarn-record-'))
    try {
      await installIntoStaging({ ref, version: inspected.version, staging })
      await cp(
        join(staging, STAGING_SKILLS_DIR, `@${ref.owner}`, ref.slug),
        join(target, 'files'),
        {
          recursive: true,
          // `.clawhub/` is ClawHub's local provenance, not something the registry serves.
          filter: (source) => !source.split(sep).includes('.clawhub'),
        },
      )
    } finally {
      await rm(staging, { recursive: true, force: true })
    }

    // The fake recomputes `files` from the recorded bytes, so keeping the manifest here
    // would be a second source of truth that could quietly disagree with itself.
    if (raw.version !== undefined) raw.version.files = []
    await writeFile(join(target, 'inspect.json'), `${JSON.stringify(raw, null, 2)}\n`)
    process.stderr.write(`recorded @${ref.owner}/${ref.slug}@${inspected.version}\n`)
  }
} catch (error) {
  if (isSkbError(error)) {
    process.stderr.write(`record-fixtures: ${error.message}\n`)
    if (error.hint !== undefined) process.stderr.write(`${error.hint}\n`)
    process.exit(1)
  }
  throw error
}
