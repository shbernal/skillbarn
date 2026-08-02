import { SkbError } from './errors.ts'
import { formatSkillRef, isScoped, parseSkillRef } from './slug.ts'

export const MANIFEST_FILE = 'skills.json'

/** The only source for now. Recorded explicitly so multi-registry needs no migration. */
export type SkillSource = 'clawhub'

export type ManifestEntry = {
  source: SkillSource
  /** The version the user asked for. Absent means "whatever was latest when added". */
  version?: string
}

/** Declared intent: what the project wants, keyed by `@owner/slug`. */
export type Manifest = {
  skills: Record<string, ManifestEntry>
}

export function emptyManifest(): Manifest {
  return { skills: {} }
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

  const skillsRaw = (raw as { skills?: unknown }).skills ?? {}
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
  return { skills }
}

/** Stable key order, so a regenerated manifest never produces a spurious diff. */
export function renderManifest(manifest: Manifest): string {
  const skills: Record<string, ManifestEntry> = {}
  for (const ref of Object.keys(manifest.skills).sort()) {
    const entry = manifest.skills[ref]
    if (entry !== undefined) skills[ref] = entry
  }
  return `${JSON.stringify({ skills }, null, 2)}\n`
}
