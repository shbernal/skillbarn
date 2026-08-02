import { inspectSkill, requireClawhub } from '../clawhub.ts'
import { loadProject } from '../config.ts'
import { SkbError } from '../errors.ts'
import { isDirectory } from '../fs-tree.ts'
import { renderSummary, summarizeSkill } from '../gate.ts'
import type { LockEntry } from '../lock.ts'
import {
  installDirName,
  lockRelativePath,
  readLockFile,
  readManifestFile,
  skillPath,
  syncGitignore,
  writeLockFile,
  writeManifestFile,
} from '../project.ts'
import { formatSkillRef, parseSkillRef } from '../slug.ts'
import { confirm, err, out } from '../ui.ts'
import { vendorSkill } from '../vendor.ts'

export type AddOptions = {
  ref: string
  version: string | undefined
  yes: boolean
  force: boolean
  cwd: string
}

export async function cmdAdd(options: AddOptions): Promise<number> {
  const requested = parseSkillRef(options.ref)
  const project = await loadProject(options.cwd)
  await requireClawhub()

  // One call: the confirmation gate, the resolved owner and version, and the per-file
  // manifest the download is checked against all come out of this.
  const inspected = await inspectSkill(requested, options.version)
  const ref = { owner: inspected.owner, slug: inspected.slug }
  const dirName = installDirName(ref, project.config.flatten)

  const lock = await readLockFile(project)
  const manifest = await readManifestFile(project)
  const existing = lock.skills[inspected.slug]

  if (!options.force && (await isDirectory(skillPath(project, dirName)))) {
    if (existing !== undefined && existing.owner !== inspected.owner) {
      throw new SkbError(
        `${inspected.slug} is already vendored from @${existing.owner}`,
        'two skills with the same slug cannot both be installed: loaders key on the ' +
          'name declared in SKILL.md, so renaming the directory would not separate them',
      )
    }
    throw new SkbError(
      `${dirName} already exists in ${project.config.dir}`,
      existing === undefined
        ? 'it is not in the lock, so skillbarn will not overwrite it — move it aside first'
        : 'pass --force to reinstall it',
    )
  }

  const summary = summarizeSkill(inspected)
  err(renderSummary(summary))
  err('')
  if (!(await confirm(`install ${summary.ref}@${summary.version}?`, options.yes))) {
    err('aborted')
    return 1
  }

  const result = await vendorSkill(project, {
    ref,
    version: inspected.version,
    expectedFiles: inspected.files,
    replace: true,
  })

  const entry: LockEntry = {
    source: 'clawhub',
    owner: ref.owner,
    slug: ref.slug,
    version: inspected.version,
    path: lockRelativePath(project, result.dirName),
    integrity: result.integrity,
  }
  lock.skills[ref.slug] = entry
  manifest.skills[formatSkillRef(ref)] = { source: 'clawhub', version: inspected.version }

  await writeManifestFile(project, manifest)
  await writeLockFile(project, lock)
  await syncGitignore(project, lock)

  out(`added ${formatSkillRef(ref)}@${inspected.version} -> ${entry.path}`)
  return 0
}
