import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { digestTree, isDirectory, pathExists, readDirNames } from './fs-tree.ts'
import { renderGitignore } from './gitignore.ts'
import { lockedSlugs } from './lock.ts'
import { entryPath, gitignorePath, ignoredDirNames, loadProject, readLockFile } from './project.ts'
import { activeStagingDirs } from './staging.ts'

/**
 * The properties skillbarn promises about a project directory. This is the real
 * specification: scripted tests and exploratory agent runs call the same function, so
 * a surprise found by poking at it by hand lands as a failure of a named invariant
 * rather than as prose in a report.
 */
export type Violation = {
  invariant: string
  detail: string
}

export const INVARIANTS = [
  'lock-matches-disk',
  'nothing-outside-skills-dir',
  'install-is-a-noop',
  'gitignore-matches-lock',
  'no-scoped-directories',
  'staging-torn-down',
] as const

export async function checkInvariants(projectDir: string): Promise<Violation[]> {
  const project = await loadProject(projectDir)
  const lock = await readLockFile(project)
  const violations: Violation[] = []

  // 1 + 3: every lock entry present and digest-matching. These are the same check:
  // an install is a no-op exactly when nothing is missing and nothing has drifted.
  for (const slug of lockedSlugs(lock)) {
    const entry = lock.skills[slug]
    if (entry === undefined) continue
    const dir = entryPath(project, entry)
    if (!(await isDirectory(dir))) {
      violations.push({
        invariant: 'lock-matches-disk',
        detail: `${slug} is locked but not installed`,
      })
      violations.push({ invariant: 'install-is-a-noop', detail: `${slug} would be reinstalled` })
      continue
    }
    const digest = await digestTree(dir)
    if (digest !== entry.integrity) {
      violations.push({
        invariant: 'lock-matches-disk',
        detail: `${slug} does not match its locked integrity (${digest} != ${entry.integrity})`,
      })
    }
  }

  const managedDirs = new Set(ignoredDirNames(lock))
  const onDisk = await readDirNames(project.skillsDir)

  // 1 (other direction): a directory that is neither locked nor plainly local.
  // "Local" means hand-authored and unmanaged; the lock is the only definition of
  // vendored, since flattening removed the `@` that used to distinguish them.
  for (const name of onDisk) {
    if (name.startsWith('@') || managedDirs.has(name)) continue
    if (await pathExists(join(project.skillsDir, name, '.clawhub'))) {
      violations.push({
        invariant: 'lock-matches-disk',
        detail: `${name} looks vendored (has .clawhub/) but is not in the lock`,
      })
    }
  }

  // 2: staging exists precisely so ClawHub's own lockfile never lands in the repo.
  if (await pathExists(join(project.root, '.clawhub'))) {
    violations.push({
      invariant: 'nothing-outside-skills-dir',
      detail: '.clawhub/ exists at the project root',
    })
  }

  // 4: the managed gitignore is generated, never merged — so it must be byte-equal.
  if (project.config.gitignore === 'managed') {
    const path = gitignorePath(project)
    const expected = renderGitignore(ignoredDirNames(lock))
    const actual = (await pathExists(path)) ? await readFile(path, 'utf8') : null
    if (actual === null) {
      // Absent is correct while nothing is vendored: there is nothing to ignore, and a
      // project that has never run a skillbarn command should not look broken.
      if (managedDirs.size > 0) {
        violations.push({ invariant: 'gitignore-matches-lock', detail: `${path} is missing` })
      }
    } else if (actual !== expected) {
      violations.push({
        invariant: 'gitignore-matches-lock',
        detail: `${path} is not the render of the current lock`,
      })
    }
  }

  // 5: an unflattened `@owner/slug/` is a half-finished install — unless the project
  // turned flattening off, in which case it is exactly where the lock says it is.
  // Recursing loaders would otherwise pick the skill up twice.
  for (const scope of onDisk) {
    if (!scope.startsWith('@')) continue
    for (const slug of await readDirNames(join(project.skillsDir, scope))) {
      const dirName = `${scope}/${slug}`
      if (managedDirs.has(dirName)) continue
      violations.push({
        invariant: 'no-scoped-directories',
        detail: `${dirName}/ survived a command`,
      })
    }
  }

  // 6: teardown, including on failure paths.
  for (const staging of activeStagingDirs()) {
    violations.push({ invariant: 'staging-torn-down', detail: `${staging} is still active` })
  }

  return violations
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `  ${v.invariant}: ${v.detail}`).join('\n')
}
