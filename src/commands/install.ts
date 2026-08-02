import { requireClawhub } from '../clawhub.ts'
import { SkbError } from '../errors.ts'
import { digestTree, isDirectory } from '../fs-tree.ts'
import { reconcile } from '../lock.ts'
import {
  entryPath,
  loadProject,
  readLockFile,
  readManifestFile,
  requireIdentifiedProject,
  syncGitignore,
} from '../project.ts'
import { formatSkillRef } from '../slug.ts'
import { err, out } from '../ui.ts'
import { sweepScopedDirs, vendorSkill } from '../vendor.ts'

export type InstallOptions = {
  force: boolean
  cwd: string
}

/**
 * Restore exactly what the lock records.
 *
 * Never `clawhub update --all`: that resolves to latest, which would silently turn a
 * restore into an upgrade. It also cannot see flattened installs — `clawhub list`
 * reports them as manually installed — so skillbarn's lock is the only authority here.
 */
export async function cmdInstall(options: InstallOptions): Promise<number> {
  const project = await loadProject(options.cwd)
  await requireIdentifiedProject(project)
  const lock = await readLockFile(project)
  const manifest = await readManifestFile(project)
  const plan = reconcile(manifest, lock)

  for (const ref of plan.missingFromLock) {
    err(`warning: ${ref} is in skillbarn.json but not locked — run \`skb add ${ref}\``)
  }
  for (const slug of plan.staleInLock) {
    err(`warning: ${slug} is locked but not in skillbarn.json — run \`skb remove ${slug}\``)
  }

  // Before anything else: a crash between install and flatten leaves a scoped
  // directory behind, which recursing loaders would pick up as a second copy.
  const swept = await sweepScopedDirs(project, lock)
  for (const dir of swept) err(`removed stray ${dir}/ left by an interrupted run`)

  if (plan.restore.length === 0) {
    await syncGitignore(project, lock)
    out('nothing to install')
    return 0
  }

  await requireClawhub()

  let installed = 0
  let skipped = 0
  for (const entry of plan.restore) {
    const ref = { owner: entry.owner, slug: entry.slug }
    const dir = entryPath(project, entry)

    // Presence is decided from skillbarn's own lock plus the tree on disk. ClawHub
    // cannot see flattened installs and would happily lay down a duplicate.
    if (!options.force && (await isDirectory(dir))) {
      const digest = await digestTree(dir)
      if (digest === entry.integrity) {
        skipped++
        continue
      }
      throw new SkbError(
        `${entry.slug} on disk does not match the lock`,
        `locked ${entry.integrity}, found ${digest} — pass --force to overwrite the local copy`,
      )
    }

    await vendorSkill(project, {
      ref,
      version: entry.version,
      expectedIntegrity: entry.integrity,
      replace: true,
    })
    out(`installed ${formatSkillRef(ref)}@${entry.version}`)
    installed++
  }

  // `install` never writes the lock — it only obeys it.
  await syncGitignore(project, lock)

  out(`${installed} installed, ${skipped} up to date`)
  return 0
}
