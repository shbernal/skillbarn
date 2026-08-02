import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve, sep } from 'node:path'
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
  MANIFEST_FILE,
  type Manifest,
  newManifest,
  parseManifest,
  renderManifest,
  resolveConfig,
  type SkillbarnConfig,
} from './manifest.ts'
import type { SkillRef } from './slug.ts'

export const GITIGNORE_FILE = '.gitignore'

/** What decided the project root. `cwd` is the fallback: nothing identified a project. */
export type ProjectOrigin = 'manifest' | 'git' | 'cwd'

export type Project = {
  /** Absolute, realpath-resolved project root. */
  root: string
  /** How `root` was found. `requireIdentifiedProject` refuses to act on `'cwd'`. */
  origin: ProjectOrigin
  /** The configuration in force — the manifest's config half, over the defaults. */
  config: SkillbarnConfig
  /**
   * Absolute skills directory, with every existing path component resolved. If
   * `.agents/skills` is a symlink into `.claude/skills`, writes must land in the real
   * tree — otherwise the managed `.gitignore` ends up in someone else's directory.
   */
  skillsDir: string
}

/**
 * `skillbarn.json` wins, then the git root, then the cwd.
 *
 * The walk continues past a `.git` it has found, so a manifest higher up still wins — a
 * repository nested inside a skillbarn project is not a second project.
 */
export async function findProjectRoot(cwd: string): Promise<{
  root: string
  origin: ProjectOrigin
}> {
  const start = resolve(cwd)
  let gitRoot: string | null = null

  let current = start
  for (;;) {
    if (await isFile(resolve(current, MANIFEST_FILE))) return { root: current, origin: 'manifest' }
    if (gitRoot === null && (await exists(resolve(current, '.git')))) gitRoot = current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return gitRoot === null ? { root: start, origin: 'cwd' } : { root: gitRoot, origin: 'git' }
}

/**
 * The manifest is read here for its config half only. Commands that touch the skills
 * half read it again through `readManifestFile`, so a rewrite is never based on a copy
 * that has been sitting on a `Project` since the command started.
 */
export async function loadProject(cwd: string): Promise<Project> {
  const found = await findProjectRoot(cwd)
  const root = await realpathOrSelf(found.root)
  const config = resolveConfig((await readManifestAt(root)).config)

  return {
    root,
    origin: found.origin,
    config,
    skillsDir: await resolveRealPath(resolve(root, config.dir)),
  }
}

/**
 * Refuse to act when nothing identified a project root.
 *
 * `skb` is installed globally and infers the project from the working directory, so
 * without this `skb add` typed in a home directory would create `skillbarn.json`,
 * `skillbarn.lock` and a skills tree there. Guessing is the repair this tool does not do.
 *
 * A lock is evidence on its own. Origin `'cwd'` already means the walk found no manifest
 * anywhere above, so the manifest cannot be the thing that vouches here — but a project
 * unpacked from a tarball has no `.git` either, and refusing to `skb install` what the
 * lock plainly describes would be the wrong answer.
 */
export async function requireIdentifiedProject(project: Project): Promise<void> {
  if (project.origin !== 'cwd') return
  if (await pathExists(lockPath(project))) return
  throw new SkbError(
    `no project here: ${project.root} is not a git repository and has no ${MANIFEST_FILE}`,
    'run `skb init` to make this directory a skillbarn project',
  )
}

/**
 * Whether the project already has a `skillbarn.json`. When it does not, the next command
 * that writes one is creating it, and `add` says so before asking.
 *
 * The origin is the whole answer: the walk looks for a manifest at every level before it
 * settles for the git root or the cwd, so any other origin means there is none above
 * either.
 */
export function hasManifest(project: Project): boolean {
  return project.origin === 'manifest'
}

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
  return readManifestAt(project.root)
}

export async function writeManifestFile(project: Project, manifest: Manifest): Promise<void> {
  await writeFile(manifestPath(project), renderManifest(manifest), 'utf8')
}

/**
 * Absent means "the manifest that would be created", not "an empty one". A command that
 * goes on to write is then creating a file that states its configuration, and one that
 * only reads resolves the same defaults it would have resolved anyway.
 */
async function readManifestAt(root: string): Promise<Manifest> {
  const path = resolve(root, MANIFEST_FILE)
  if (!(await isFile(path))) return newManifest()
  return parseManifest(await readFile(path, 'utf8'))
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

/**
 * Resolve symlinks in the deepest existing ancestor of a path that may not exist yet,
 * then re-append the missing tail.
 */
export async function resolveRealPath(target: string): Promise<string> {
  const tail: string[] = []
  let current = resolve(target)
  for (;;) {
    if (await exists(current)) return resolve(await realpath(current), ...tail.reverse())
    const parent = dirname(current)
    if (parent === current) return target
    tail.push(current.slice(parent.length + sep.length))
    current = parent
  }
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * Follows symlinks, unlike `fs-tree`'s `pathExists` — a dangling link is not a path
 * `realpath` can resolve, so `resolveRealPath` has to keep walking up past one.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
