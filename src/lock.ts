import { SkbError } from './errors.ts'
import type { Manifest, SkillSource } from './manifest.ts'
import { formatSkillRef } from './slug.ts'

export const LOCK_FILE = 'skillbarn.lock'
export const LOCKFILE_VERSION = 1

export type LockEntry = {
  source: SkillSource
  owner: string
  slug: string
  /** The resolved version, never a range. `install` reproduces exactly this. */
  version: string
  /** Install path, relative to the project root and POSIX-separated. */
  path: string
  /** `sha256-<hex>` over the installed tree — see digest.ts for what is excluded. */
  integrity: string
}

/** Recorded fact: what is actually installed, keyed by the flattened directory name. */
export type Lock = {
  lockfileVersion: number
  skills: Record<string, LockEntry>
}

export function emptyLock(): Lock {
  return { lockfileVersion: LOCKFILE_VERSION, skills: {} }
}

export function lockRef(entry: LockEntry): string {
  return formatSkillRef({ owner: entry.owner, slug: entry.slug })
}

/** Slugs of everything vendored — the sole definition of what the gitignore covers. */
export function lockedSlugs(lock: Lock): string[] {
  return Object.keys(lock.skills).sort()
}

export function parseLock(text: string, file = LOCK_FILE): Lock {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new SkbError(`${file} is not valid JSON: ${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SkbError(`${file} must contain a JSON object`)
  }

  const obj = raw as { lockfileVersion?: unknown; skills?: unknown }
  if (typeof obj.lockfileVersion !== 'number') {
    throw new SkbError(`${file}: missing "lockfileVersion"`)
  }
  if (obj.lockfileVersion > LOCKFILE_VERSION) {
    throw new SkbError(
      `${file} was written by a newer skillbarn (lockfileVersion ${obj.lockfileVersion})`,
      'upgrade skillbarn to read it',
    )
  }

  const skillsRaw = obj.skills ?? {}
  if (typeof skillsRaw !== 'object' || skillsRaw === null || Array.isArray(skillsRaw)) {
    throw new SkbError(`${file}: "skills" must be an object`)
  }

  const skills: Record<string, LockEntry> = {}
  for (const [slug, value] of Object.entries(skillsRaw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SkbError(`${file}: entry "${slug}" must be an object`)
    }
    const entry = value as Record<string, unknown>
    for (const field of ['owner', 'version', 'path', 'integrity'] as const) {
      if (typeof entry[field] !== 'string') {
        throw new SkbError(`${file}: entry "${slug}" is missing "${field}"`)
      }
    }
    if (entry.source !== undefined && entry.source !== 'clawhub') {
      throw new SkbError(`${file}: entry "${slug}" has unknown source ${String(entry.source)}`)
    }
    if (entry.slug !== undefined && entry.slug !== slug) {
      throw new SkbError(`${file}: entry "${slug}" disagrees with its own slug field`)
    }
    skills[slug] = {
      source: 'clawhub',
      owner: entry.owner as string,
      slug,
      version: entry.version as string,
      path: entry.path as string,
      integrity: entry.integrity as string,
    }
  }
  return { lockfileVersion: LOCKFILE_VERSION, skills }
}

export function renderLock(lock: Lock): string {
  const skills: Record<string, LockEntry> = {}
  for (const slug of lockedSlugs(lock)) {
    const entry = lock.skills[slug]
    if (entry !== undefined) skills[slug] = entry
  }
  return `${JSON.stringify({ lockfileVersion: LOCKFILE_VERSION, skills }, null, 2)}\n`
}

export type Reconciliation = {
  /** Lock entries to restore, in a stable order. The lock is what `install` obeys. */
  restore: LockEntry[]
  /** Declared in the manifest but never locked — needs `skb add`, not `skb install`. */
  missingFromLock: string[]
  /** Locked but no longer declared — needs `skb remove`. */
  staleInLock: string[]
}

/**
 * Manifest is intent, lock is fact. `install` restores exactly the lock; anything the
 * two disagree about is reported, never silently resolved — resolving it would mean
 * either a network fetch (for an unlocked want) or a deletion (for a stale entry), and
 * neither belongs in a restore.
 */
export function reconcile(manifest: Manifest, lock: Lock): Reconciliation {
  const declared = new Map<string, string>()
  for (const ref of Object.keys(manifest.skills)) {
    const slug = ref.slice(ref.indexOf('/') + 1)
    declared.set(slug, ref)
  }

  const restore: LockEntry[] = []
  const staleInLock: string[] = []
  for (const slug of lockedSlugs(lock)) {
    const entry = lock.skills[slug]
    if (entry === undefined) continue
    restore.push(entry)
    if (!declared.has(slug)) staleInLock.push(slug)
  }

  const missingFromLock: string[] = []
  for (const [slug, ref] of declared) {
    if (lock.skills[slug] === undefined) missingFromLock.push(ref)
  }

  return { restore, missingFromLock: missingFromLock.sort(), staleInLock }
}
