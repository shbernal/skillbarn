import { join } from 'node:path'
import { installIntoStaging, STAGING_SKILLS_DIR } from './clawhub.ts'
import type { Project } from './config.ts'
import { compareFileHashes, excludeFromDigest, type FileHash, treeDigest } from './digest.ts'
import { SkbError } from './errors.ts'
import {
  hashTree,
  isDirectory,
  movePath,
  readDirNames,
  removeIfEmpty,
  removePath,
} from './fs-tree.ts'
import type { Lock } from './lock.ts'
import { ignoredDirNames, installDirName, skillPath } from './project.ts'
import { formatSkillRef, type SkillRef } from './slug.ts'
import { withStaging } from './staging.ts'

export type VendorRequest = {
  ref: SkillRef & { owner: string }
  version: string
  /** The registry's own per-file manifest, cross-checked against the bytes served. */
  expectedFiles?: readonly FileHash[]
  /** A previously locked integrity value. A mismatch aborts rather than warns. */
  expectedIntegrity?: string
  /** Replace an existing directory at the destination. Callers decide; this does not. */
  replace?: boolean
}

export type VendorResult = {
  dirName: string
  integrity: string
}

/**
 * Install one skill: staging fetch, integrity check, then a move into place.
 *
 * Nothing touches the project tree until every check has passed, so a failed verify
 * cannot leave a half-installed skill behind — and staging is torn down either way.
 */
export async function vendorSkill(project: Project, request: VendorRequest): Promise<VendorResult> {
  const dirName = installDirName(request.ref, project.config.flatten)
  const destination = skillPath(project, dirName)

  if (request.replace !== true && (await isDirectory(destination))) {
    throw new SkbError(
      `${dirName} already exists in ${project.config.dir}`,
      'remove it first, or pass --force to overwrite',
    )
  }

  const integrity = await withStaging(async (staging) => {
    await installIntoStaging({ ref: request.ref, version: request.version, staging })

    const installed = join(staging, STAGING_SKILLS_DIR, `@${request.ref.owner}`, request.ref.slug)
    if (!(await isDirectory(installed))) {
      throw new SkbError(
        `clawhub reported success but installed nothing for ${formatSkillRef(request.ref)}`,
        `expected ${installed}`,
      )
    }

    const files = await hashTree(installed)
    if (request.expectedFiles !== undefined) {
      const mismatches = compareFileHashes(request.expectedFiles, files)
      if (mismatches.length > 0) {
        throw new SkbError(
          `${formatSkillRef(request.ref)}@${request.version} does not match the registry's own file manifest`,
          mismatches
            .map(
              (m) =>
                `  ${m.path}: expected ${m.expected ?? '(absent)'}, got ${m.actual ?? '(absent)'}`,
            )
            .join('\n'),
        )
      }
    }

    const digest = treeDigest(excludeFromDigest(files))
    if (request.expectedIntegrity !== undefined && digest !== request.expectedIntegrity) {
      throw new SkbError(
        `${formatSkillRef(request.ref)}@${request.version} does not match the locked integrity`,
        `locked ${request.expectedIntegrity}, got ${digest}`,
      )
    }

    await removePath(destination)
    await movePath(installed, destination)
    return digest
  })

  return { dirName, integrity }
}

/**
 * Delete `@owner/slug/` directories the lock does not claim.
 *
 * A crash between install and flatten leaves one behind, and a loader that recurses
 * (OpenClaw discovers `SKILL.md` anywhere under a root) would then load the skill
 * twice. Staging makes this nearly impossible; the sweep covers the remainder,
 * including trees left by an older skillbarn that installed in place.
 */
export async function sweepScopedDirs(project: Project, lock: Lock): Promise<string[]> {
  const managed = new Set(ignoredDirNames(lock))
  const removed: string[] = []

  for (const scope of await readDirNames(project.skillsDir)) {
    if (!scope.startsWith('@')) continue
    const scopeDir = join(project.skillsDir, scope)
    for (const slug of await readDirNames(scopeDir)) {
      if (managed.has(`${scope}/${slug}`)) continue
      await removePath(join(scopeDir, slug))
      removed.push(`${scope}/${slug}`)
    }
    await removeIfEmpty(scopeDir)
  }
  return removed
}
