import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { SkbError } from './errors.ts'

export const CONFIG_FILE = 'skillbarn.json'

export type GitignoreMode = 'managed' | 'off'

export type SkillbarnConfig = {
  /** Skills directory, relative to the project root. */
  dir: string
  /** Move `@owner/slug/` down to `slug/` on install. See the flattening rationale in README. */
  flatten: boolean
  gitignore: GitignoreMode
}

export const DEFAULT_CONFIG: SkillbarnConfig = {
  dir: '.agents/skills',
  flatten: true,
  gitignore: 'managed',
}

export function parseConfig(text: string, file = CONFIG_FILE): SkillbarnConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new SkbError(`${file} is not valid JSON: ${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SkbError(`${file} must contain a JSON object`)
  }
  const obj = raw as Record<string, unknown>

  const config: SkillbarnConfig = { ...DEFAULT_CONFIG }

  if (obj.dir !== undefined) {
    if (typeof obj.dir !== 'string' || obj.dir === '') {
      throw new SkbError(`${file}: "dir" must be a non-empty string`)
    }
    if (isAbsolute(obj.dir) || obj.dir.split(/[\\/]/).includes('..')) {
      throw new SkbError(
        `${file}: "dir" must be a relative path inside the project`,
        `got ${obj.dir}`,
      )
    }
    config.dir = obj.dir
  }
  if (obj.flatten !== undefined) {
    if (typeof obj.flatten !== 'boolean') throw new SkbError(`${file}: "flatten" must be a boolean`)
    config.flatten = obj.flatten
  }
  if (obj.gitignore !== undefined) {
    if (obj.gitignore !== 'managed' && obj.gitignore !== 'off') {
      throw new SkbError(`${file}: "gitignore" must be "managed" or "off"`)
    }
    config.gitignore = obj.gitignore
  }
  return config
}

/** What decided the project root. `cwd` is the fallback: nothing identified a project. */
export type ProjectOrigin = 'config' | 'git' | 'cwd'

export type Project = {
  /** Absolute, realpath-resolved project root. */
  root: string
  /** How `root` was found. `requireIdentifiedProject` refuses to act on `'cwd'`. */
  origin: ProjectOrigin
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
 * The walk continues past a `.git` it has found, so a config file higher up still wins —
 * a repository nested inside a configured project is not a second project.
 */
export async function findProjectRoot(cwd: string): Promise<{
  root: string
  origin: ProjectOrigin
}> {
  const start = resolve(cwd)
  let gitRoot: string | null = null

  let current = start
  for (;;) {
    if (await isFile(resolve(current, CONFIG_FILE))) return { root: current, origin: 'config' }
    if (gitRoot === null && (await exists(resolve(current, '.git')))) gitRoot = current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return gitRoot === null ? { root: start, origin: 'cwd' } : { root: gitRoot, origin: 'git' }
}

export async function loadProject(cwd: string): Promise<Project> {
  const found = await findProjectRoot(cwd)
  const root = await realpathOrSelf(found.root)
  const configPath = resolve(root, CONFIG_FILE)
  const config = (await isFile(configPath))
    ? parseConfig(await readFile(configPath, 'utf8'), CONFIG_FILE)
    : { ...DEFAULT_CONFIG }

  return {
    root,
    origin: found.origin,
    config,
    skillsDir: await resolveRealPath(resolve(root, config.dir)),
  }
}

/** Serialize a config the way `skb init` writes it. */
export function renderConfig(config: SkillbarnConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
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
