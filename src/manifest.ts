import { isAbsolute } from 'node:path'
import { SkbError } from './errors.ts'
import { formatSkillRef, isScoped, parseSkillRef } from './slug.ts'

/**
 * The one file a project commits alongside its lock. It carries both halves — how the
 * project is configured and which skills it declares — the way `package.json` carries
 * both. A separate config file would need a name, and the only good one is taken.
 */
export const MANIFEST_FILE = 'skillbarn.json'

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

/** The keys skillbarn owns besides `skills`, in the order they are written back. */
const CONFIG_KEYS = ['dir', 'flatten', 'gitignore'] as const

/**
 * Configuration exactly as written, which is not the same as the configuration in force.
 * A key the file leaves out stays out: `add` and `remove` rewrite this file, and a
 * rewrite that added the defaults would put a decision in the project's mouth that
 * nobody made — and would silently pin it against a later change of default.
 *
 * Creating the file is the other case entirely; see `newManifest`.
 */
export type ManifestConfig = Partial<SkillbarnConfig>

/** The configuration in force: what was written, over the defaults. */
export function resolveConfig(config: ManifestConfig): SkillbarnConfig {
  return { ...DEFAULT_CONFIG, ...config }
}

/** The only source for now. Recorded explicitly so multi-registry needs no migration. */
export type SkillSource = 'clawhub'

export type ManifestEntry = {
  source: SkillSource
  /** The version the user asked for. Absent means "whatever was latest when added". */
  version?: string
}

export type Manifest = {
  config: ManifestConfig
  /** Declared intent: what the project wants, keyed by `@owner/slug`. */
  skills: Record<string, ManifestEntry>
  /**
   * Top-level keys skillbarn does not own — `$schema`, or a field a newer version
   * writes. Carried through a rewrite untouched, because `add` must not delete what it
   * does not understand.
   */
  extra: Record<string, unknown>
}

/** A manifest that declares nothing at all — the starting point for a synthetic one. */
export function emptyManifest(): Manifest {
  return { config: {}, skills: {}, extra: {} }
}

/**
 * The manifest skillbarn writes when the project has none, whether `init` asked for it
 * or `add` created one on the way past.
 *
 * This is the one place the defaults are written into a file, and the distinction that
 * makes it legitimate is creation versus rewrite: a file being created has no author to
 * contradict, and the settings are otherwise in force invisibly. A rewrite still adds
 * nothing — see `ManifestConfig`.
 */
export function newManifest(): Manifest {
  return { config: { ...DEFAULT_CONFIG }, skills: {}, extra: {} }
}

export function parseManifest(text: string, file = MANIFEST_FILE): Manifest {
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

  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'skills') continue
    if ((CONFIG_KEYS as readonly string[]).includes(key)) continue
    extra[key] = value
  }

  return { config: parseConfig(obj, file), skills: parseSkills(obj.skills ?? {}, file), extra }
}

function parseConfig(obj: Record<string, unknown>, file: string): ManifestConfig {
  const config: ManifestConfig = {}

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

function parseSkills(skillsRaw: unknown, file: string): Record<string, ManifestEntry> {
  if (typeof skillsRaw !== 'object' || skillsRaw === null || Array.isArray(skillsRaw)) {
    throw new SkbError(`${file}: "skills" must be an object`)
  }

  const skills: Record<string, ManifestEntry> = {}
  for (const [ref, value] of Object.entries(skillsRaw as Record<string, unknown>)) {
    const parsed = parseSkillRef(ref)
    if (!isScoped(parsed)) {
      throw new SkbError(
        `${file}: "${ref}" is missing an owner`,
        'skills must be declared as @owner/slug — bare slugs are ambiguous on ClawHub',
      )
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SkbError(`${file}: entry "${ref}" must be an object`)
    }
    const entry = value as { source?: unknown; version?: unknown }
    if (entry.source !== undefined && entry.source !== 'clawhub') {
      throw new SkbError(`${file}: entry "${ref}" has unknown source ${String(entry.source)}`)
    }
    if (entry.version !== undefined && typeof entry.version !== 'string') {
      throw new SkbError(`${file}: entry "${ref}" has a non-string version`)
    }
    skills[formatSkillRef(parsed)] =
      entry.version === undefined
        ? { source: 'clawhub' }
        : { source: 'clawhub', version: entry.version }
  }
  return skills
}

/**
 * Config first, then anything skillbarn does not own, then `skills` last — it is the
 * half that grows, and a fixed order is what keeps a regenerated manifest from producing
 * a spurious diff.
 */
export function renderManifest(manifest: Manifest): string {
  const out: Record<string, unknown> = {}

  for (const key of CONFIG_KEYS) {
    const value = manifest.config[key]
    if (value !== undefined) out[key] = value
  }
  for (const [key, value] of Object.entries(manifest.extra)) out[key] = value

  const skills: Record<string, ManifestEntry> = {}
  for (const ref of Object.keys(manifest.skills).sort()) {
    const entry = manifest.skills[ref]
    if (entry !== undefined) skills[ref] = entry
  }
  out.skills = skills

  return `${JSON.stringify(out, null, 2)}\n`
}
