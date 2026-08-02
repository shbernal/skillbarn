import { loadProject } from '../config.ts'
import { SkbError } from '../errors.ts'
import { removePath } from '../fs-tree.ts'
import {
  entryPath,
  readLockFile,
  readManifestFile,
  requireIdentifiedProject,
  syncGitignore,
  writeLockFile,
  writeManifestFile,
} from '../project.ts'
import { formatSkillRef, parseSkillRef } from '../slug.ts'
import { out } from '../ui.ts'

export type RemoveOptions = {
  ref: string
  cwd: string
}

/**
 * Purely local: delete the directory and drop the entry.
 *
 * Never `clawhub uninstall` — ClawHub does not track flattened installs, and its own
 * lockfile only ever existed inside a staging directory that is long gone.
 */
export async function cmdRemove(options: RemoveOptions): Promise<number> {
  const project = await loadProject(options.cwd)
  await requireIdentifiedProject(project)
  const parsed = parseSkillRef(options.ref)

  const lock = await readLockFile(project)
  const entry = lock.skills[parsed.slug]
  if (entry === undefined) {
    throw new SkbError(`${parsed.slug} is not vendored here`, 'nothing in the lock matches it')
  }
  if (parsed.owner !== null && parsed.owner !== entry.owner) {
    throw new SkbError(
      `${parsed.slug} is vendored from @${entry.owner}, not @${parsed.owner}`,
      'remove it by slug if that is what you meant',
    )
  }

  await removePath(entryPath(project, entry))
  delete lock.skills[parsed.slug]

  const manifest = await readManifestFile(project)
  delete manifest.skills[formatSkillRef({ owner: entry.owner, slug: entry.slug })]

  await writeManifestFile(project, manifest)
  await writeLockFile(project, lock)
  await syncGitignore(project, lock)

  out(`removed ${formatSkillRef({ owner: entry.owner, slug: entry.slug })}`)
  return 0
}
