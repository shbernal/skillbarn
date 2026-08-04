import { inspectSkill, requireClawhub } from '../clawhub.ts'
import { lockedSlugs } from '../lock.ts'
import { entryDirName, loadProject, readLockFile, requireIdentifiedProject } from '../project.ts'
import { out } from '../ui.ts'
import { classify, type Resolution } from '../update.ts'

export type OutdatedOptions = {
  cwd: string
}

/**
 * What the registry serves now, against what the lock records. Reads only.
 *
 * `install` never writes the lock and neither does this — the exit code is the whole
 * output contract, so it can run on a schedule and open a pull request without ever
 * being the thing that decided what a project depends on.
 *
 * It reports a `republished` version as loudly as an outdated one, which is only
 * possible because the integrity of a version can be computed from the registry's file
 * manifest without downloading it. See `manifestIntegrity` in `src/update.ts`.
 */
export async function cmdOutdated(options: OutdatedOptions): Promise<number> {
  const project = await loadProject(options.cwd)
  await requireIdentifiedProject(project)
  const lock = await readLockFile(project)

  const slugs = lockedSlugs(lock)
  if (slugs.length === 0) {
    out('nothing vendored')
    return 0
  }
  await requireClawhub()

  const resolutions: Resolution[] = []
  for (const slug of slugs) {
    const entry = lock.skills[slug]
    if (entry === undefined) continue
    const inspected = await inspectSkill({ owner: entry.owner, slug: entry.slug })
    resolutions.push(classify(entry, inspected))
  }

  const rows = resolutions.map((resolution) => [
    entryDirName(resolution.entry),
    `@${resolution.entry.owner}`,
    resolution.entry.version,
    resolution.status === 'current' ? '=' : resolution.version,
    resolution.status,
  ])
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  )
  for (const row of rows) {
    out(
      row
        .map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
  }

  return resolutions.some((resolution) => resolution.status !== 'current') ? 1 : 0
}
