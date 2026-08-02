import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import { CONFIG_FILE, type Project } from './config.ts'
import { SkbError } from './errors.ts'
import { pathExists, removePath } from './fs-tree.ts'
import { GITIGNORE_HEADER, renderGitignore } from './gitignore.ts'
import {
  emptyLock,
  LOCK_FILE,
  type Lock,
  type LockEntry,
  lockedSlugs,
  parseLock,
  renderLock,
} from './lock.ts'
import {
  emptyManifest,
  MANIFEST_FILE,
  type Manifest,
  parseManifest,
  renderManifest,
} from './manifest.ts'
import type { SkillRef } from './slug.ts'

export const GITIGNORE_FILE = '.gitignore'

export function manifestPath(project: Project): string {
  return resolve(project.root, MANIFEST_FILE)
}

export function lockPath(project: Project): string {
  return resolve(project.root, LOCK_FILE)
}

export function gitignorePath(project: Project): string {
  return join(project.skillsDir, GITIGNORE_FILE)
}

/**
 * Refuse to act when nothing identified a project root.
 *
 * `skb` is installed globally and infers the project from the working directory, so
 * without this `skb add` typed in a home directory would create `skills.json`,
 * `skillbarn.lock` and a skills tree there. Guessing is the repair this tool does not do.
 *
 * An existing manifest or lock is evidence enough on its own: a project unpacked from a
 * tarball has no `.git`, and refusing to `skb install` there would be the wrong answer.
 */
export async function requireIdentifiedProject(project: Project): Promise<void> {
  if (project.origin !== 'cwd') return
  if (await pathExists(manifestPath(project))) return
  if (await pathExists(lockPath(project))) return
  throw new SkbError(
    `no project here: ${project.root} is not a git repository and has no ${CONFIG_FILE}`,
    'run `skb init` to make this directory a skillbarn project',
  )
}

/**
 * Directory a skill installs into, relative to the skills directory. Flattening is
 * what makes the tree readable by the strictest loaders (Claude Code scans one level
 * deep, OpenCode globs `*​/SKILL.md`); the owner survives as lock metadata instead.
 */
export function installDirName(ref: SkillRef & { owner: string }, flatten: boolean): string {
  return flatten ? ref.slug : `@${ref.owner}/${ref.slug}`
}

/**
 * Recover the directory name from a lock entry's recorded path. Read back from the
 * path rather than recomputed from config, so an entry locked under one `flatten`
 * setting is still found after the setting changes.
 */
export function entryDirName(entry: LockEntry): string {
  const parts = entry.path.split(posix.sep)
  const parent = parts.at(-2)
  return parent?.startsWith('@') ? `${parent}/${parts.at(-1)}` : (parts.at(-1) ?? entry.slug)
}

/** Absolute path of an installed skill. */
export function skillPath(project: Project, dirName: string): string {
  return join(project.skillsDir, ...dirName.split(posix.sep))
}

export function entryPath(project: Project, entry: LockEntry): string {
  return skillPath(project, entryDirName(entry))
}

/** The `path` recorded in the lock: relative to the project root, POSIX-separated. */
export function lockRelativePath(project: Project, dirName: string): string {
  return posix.join(project.config.dir.split(/[\\/]/).join(posix.sep), dirName)
}

export async function readManifestFile(project: Project): Promise<Manifest> {
  const path = manifestPath(project)
  if (!(await pathExists(path))) return emptyManifest()
  return parseManifest(await readFile(path, 'utf8'))
}

export async function writeManifestFile(project: Project, manifest: Manifest): Promise<void> {
  await writeFile(manifestPath(project), renderManifest(manifest), 'utf8')
}

export async function readLockFile(project: Project): Promise<Lock> {
  const path = lockPath(project)
  if (!(await pathExists(path))) return emptyLock()
  return parseLock(await readFile(path, 'utf8'))
}

export async function writeLockFile(project: Project, lock: Lock): Promise<void> {
  await writeFile(lockPath(project), renderLock(lock), 'utf8')
}

/** Directory names the managed gitignore covers — derived from the lock, never from disk. */
export function ignoredDirNames(lock: Lock): string[] {
  return lockedSlugs(lock)
    .map((slug) => lock.skills[slug])
    .filter((entry): entry is LockEntry => entry !== undefined)
    .map(entryDirName)
}

/**
 * Regenerate `<dir>/.gitignore` from the lock. The file is written inside the skills
 * directory rather than at the repo root: it keeps the root clean, documents itself
 * next to what it describes, and scopes the rules to that tree.
 */
export async function syncGitignore(project: Project, lock: Lock): Promise<void> {
  const path = gitignorePath(project)

  if (project.config.gitignore === 'off') {
    // Only ever remove a file we wrote ourselves.
    if (await pathExists(path)) {
      const existing = await readFile(path, 'utf8')
      if (existing.startsWith(GITIGNORE_HEADER)) await removePath(path)
    }
    return
  }

  await mkdir(project.skillsDir, { recursive: true })
  await writeFile(path, renderGitignore(ignoredDirNames(lock)), 'utf8')
}
