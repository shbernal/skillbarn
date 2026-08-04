import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectSkill, requireClawhub } from '../clawhub.ts'
import { diffLines } from '../diff.ts'
import { SkbError } from '../errors.ts'
import { renderUpdate, summarizeSkill, summarizeSkillText } from '../gate.ts'
import { type Lock, type LockEntry, lockedSlugs } from '../lock.ts'
import { MANIFEST_FILE, type Manifest } from '../manifest.ts'
import {
  entryPath,
  loadProject,
  lockRelativePath,
  readLockFile,
  readManifestFile,
  requireIdentifiedProject,
  syncGitignore,
  writeLockFile,
  writeManifestFile,
} from '../project.ts'
import { formatSkillRef, parseSkillRef } from '../slug.ts'
import { confirm, err, out } from '../ui.ts'
import { classify } from '../update.ts'
import { vendorSkill } from '../vendor.ts'

export type UpdateOptions = {
  /** A single slug, or undefined for everything the lock records. */
  ref: string | undefined
  version: string | undefined
  yes: boolean
  cwd: string
}

/**
 * Move a vendored skill to another version of itself.
 *
 * The gate is the point of the command, not an obstacle in front of it. ClawHub
 * publishing is open — a GitHub account a week old is enough — so a new version is a
 * fresh grant of execution trust to whoever holds that account rather than a
 * continuation of the one already given. So each skill is shown and confirmed
 * separately: a single prompt covering five skills is the prompt nobody reads.
 *
 * Each accepted skill is written through completely — tree, lock and manifest — before
 * the next is looked at, so an interrupted run leaves a project that still matches its
 * own lock, just with fewer skills moved than asked for.
 */
export async function cmdUpdate(options: UpdateOptions): Promise<number> {
  const project = await loadProject(options.cwd)
  await requireIdentifiedProject(project)

  const lock = await readLockFile(project)
  const manifest = await readManifestFile(project)
  const targets = selectTargets(lock, manifest, options.ref)

  if (targets.length === 0) {
    out(options.ref === undefined ? 'nothing vendored' : 'nothing to update')
    return 0
  }
  await requireClawhub()

  let updated = 0
  let declined = 0
  let candidates = 0

  for (const entry of targets) {
    const ref = { owner: entry.owner, slug: entry.slug }
    const inspected = await inspectSkill(ref, options.version)
    if (inspected.owner !== entry.owner) {
      throw new SkbError(
        `${formatSkillRef(ref)} now resolves to @${inspected.owner}`,
        'the registry moved the slug to another owner — remove it and add it again deliberately',
      )
    }

    const resolution = classify(entry, inspected)
    if (resolution.status === 'current') continue
    candidates++

    // The installed SKILL.md is the other half of the diff, and reading it is also the
    // only way to say which commands and env vars the new text *adds*. A missing one is
    // not an error here: `install` and `verify` are what report a tree gone astray.
    const installedSource = await readIfPresent(join(entryPath(project, entry), 'SKILL.md'))

    err(
      renderUpdate(
        summarizeSkill(inspected),
        entry.version,
        summarizeSkillText(installedSource),
        diffLines(installedSource, inspected.description),
      ),
    )
    err('')
    const question =
      resolution.status === 'republished'
        ? `replace ${formatSkillRef(ref)}@${entry.version} with the bytes now served?`
        : `update ${formatSkillRef(ref)} ${entry.version} -> ${resolution.version}?`
    if (!(await confirm(question, options.yes))) {
      err(`skipped ${formatSkillRef(ref)}`)
      declined++
      continue
    }

    const result = await vendorSkill(project, {
      ref,
      version: resolution.version,
      expectedFiles: inspected.files,
      replace: true,
    })

    lock.skills[entry.slug] = {
      ...entry,
      version: resolution.version,
      path: lockRelativePath(project, result.dirName),
      integrity: result.integrity,
    }
    const declaration = manifest.skills[formatSkillRef(ref)]
    if (declaration !== undefined) declaration.version = resolution.version

    // Both records, per skill, before the next one is touched.
    await writeManifestFile(project, manifest)
    await writeLockFile(project, lock)

    out(`updated ${formatSkillRef(ref)} ${entry.version} -> ${resolution.version}`)
    updated++
  }

  await syncGitignore(project, lock)

  if (candidates === 0) {
    out('everything is up to date')
    return 0
  }
  out(`${updated} updated, ${declined} skipped`)
  return updated === 0 ? 1 : 0
}

/**
 * The lock is what `update` walks, but only where the manifest still declares the skill.
 *
 * Writing a version back into a declaration that is not there would be adding one, and
 * an entry the project deleted from `skillbarn.json` is a disagreement to report rather
 * than repair — the same posture `skb install` takes on it.
 */
function selectTargets(lock: Lock, manifest: Manifest, ref: string | undefined): LockEntry[] {
  const isDeclared = (entry: LockEntry) =>
    manifest.skills[formatSkillRef({ owner: entry.owner, slug: entry.slug })] !== undefined

  if (ref === undefined) {
    const targets: LockEntry[] = []
    for (const slug of lockedSlugs(lock)) {
      const entry = lock.skills[slug]
      if (entry === undefined) continue
      if (!isDeclared(entry)) {
        err(`warning: ${slug} is locked but not in ${MANIFEST_FILE} — run \`skb remove ${slug}\``)
        continue
      }
      targets.push(entry)
    }
    return targets
  }

  const parsed = parseSkillRef(ref)
  const entry = lock.skills[parsed.slug]
  if (entry === undefined) {
    throw new SkbError(`${parsed.slug} is not vendored here`, 'nothing in the lock matches it')
  }
  if (parsed.owner !== null && parsed.owner !== entry.owner) {
    throw new SkbError(
      `${parsed.slug} is vendored from @${entry.owner}, not @${parsed.owner}`,
      'update it by slug if that is what you meant',
    )
  }
  if (!isDeclared(entry)) {
    throw new SkbError(
      `${parsed.slug} is locked but not declared in ${MANIFEST_FILE}`,
      `declare it again, or run \`skb remove ${parsed.slug}\``,
    )
  }
  return [entry]
}

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}
