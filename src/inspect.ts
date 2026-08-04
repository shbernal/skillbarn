import type { FileHash } from './digest.ts'
import { SkbError } from './errors.ts'

/** Parsed `clawhub inspect <ref> --files --json`. Only the fields skillbarn relies on. */
export type InspectedFile = FileHash & {
  size: number
  contentType: string | null
}

export type InspectResult = {
  slug: string
  owner: string
  displayName: string
  summary: string
  /** The full SKILL.md source, frontmatter included. */
  description: string
  version: string
  license: string | null
  changelog: string | null
  files: InspectedFile[]
  security: SecuritySummary
}

/** One thing a scanner looked at and did not rate `ok`. */
export type SecurityNote = {
  label: string
  rating: string
  detail: string
}

export type SecuritySummary = {
  status: string | null
  hasWarnings: boolean
  /** Per-scanner verdicts, e.g. `vt`, `skillspector`, `llm`. */
  scanners: Record<string, string>
  /** A scanner's own severity rating for the version, when one reported it. */
  severity: string | null
  /** The dimensions a scanner flagged. Empty is the common case and says so. */
  notes: SecurityNote[]
  /** A scanner's advice to whoever is about to install this. */
  guidance: string | null
}

function fail(detail: string): never {
  throw new SkbError(
    `could not read clawhub inspect output: ${detail}`,
    'this usually means the installed clawhub is a different version than skillbarn expects',
  )
}

export function parseInspectJson(text: string): InspectResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    fail((err as Error).message)
  }
  if (typeof raw !== 'object' || raw === null) fail('not an object')

  const root = raw as Record<string, unknown>
  const skill = asRecord(root.skill) ?? fail('missing "skill"')
  const version =
    asRecord(root.version) ?? asRecord(root.latestVersion) ?? fail('missing "version"')
  const owner = asRecord(root.owner) ?? fail('missing "owner"')

  const slug = asString(skill.slug) ?? fail('missing skill.slug')
  const ownerHandle = asString(owner.handle) ?? fail('missing owner.handle')
  const versionString = asString(version.version) ?? fail('missing version.version')

  const filesRaw = version.files
  if (!Array.isArray(filesRaw)) {
    fail('missing version.files — was --files passed?')
  }

  const files = filesRaw.map((entry, i): InspectedFile => {
    const file = asRecord(entry) ?? fail(`version.files[${i}] is not an object`)
    return {
      path: asString(file.path) ?? fail(`version.files[${i}].path`),
      sha256: asString(file.sha256) ?? fail(`version.files[${i}].sha256`),
      size: typeof file.size === 'number' ? file.size : 0,
      contentType: asString(file.contentType) ?? null,
    }
  })

  return {
    slug,
    owner: ownerHandle,
    displayName: asString(skill.displayName) ?? slug,
    summary: asString(skill.summary) ?? '',
    description: asString(skill.description) ?? '',
    version: versionString,
    license: asString(version.license),
    changelog: asString(version.changelog),
    files,
    security: parseSecurity(version.security),
  }
}

/**
 * The scan report ClawHub already ships inside `inspect`.
 *
 * There is a `clawhub scan` subcommand, and it is not what this is: it *submits* a new
 * scan and waits on a queue, measured at around a minute. The stored verdicts for a
 * published version arrive here for free, on a call the add flow already makes, which is
 * why nothing shells out for them. See [docs/clawhub.md](../docs/clawhub.md).
 *
 * Nothing here is keyed to a scanner by name. `severity`, `dimensions` and `guidance`
 * are today's `skillspector` and `llm` fields, but a report skillbarn cannot read is a
 * report the user never sees, so anything shaped right is read wherever it turns up.
 */
function parseSecurity(raw: unknown): SecuritySummary {
  const empty: SecuritySummary = {
    status: null,
    hasWarnings: false,
    scanners: {},
    severity: null,
    notes: [],
    guidance: null,
  }
  const security = asRecord(raw)
  if (security === null) return empty

  const scanners: Record<string, string> = {}
  const notes: SecurityNote[] = []
  let severity: string | null = null
  let guidance: string | null = null

  for (const [name, value] of Object.entries(asRecord(security.scanners) ?? {})) {
    const scanner = asRecord(value)
    if (scanner === null) continue
    const status = asString(scanner.normalizedStatus) ?? asString(scanner.status)
    if (status !== null) scanners[name] = status
    severity ??= asString(scanner.severity)
    guidance ??= asString(scanner.guidance)

    if (!Array.isArray(scanner.dimensions)) continue
    for (const entry of scanner.dimensions) {
      const dimension = asRecord(entry)
      if (dimension === null) continue
      const rating = asString(dimension.rating)
      // `ok` is the overwhelming majority and printing it would bury the rest.
      if (rating === null || rating === 'ok') continue
      notes.push({
        label: asString(dimension.label) ?? asString(dimension.name) ?? name,
        rating,
        detail: asString(dimension.detail) ?? '',
      })
    }
  }

  return {
    status: asString(security.status),
    hasWarnings: security.hasWarnings === true,
    scanners,
    severity,
    notes,
    guidance,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * ClawHub rejects a bare slug that several owners publish, listing the candidates.
 * We surface that list rather than guessing an owner.
 */
export function parseAmbiguousSlugError(stderr: string): string[] {
  const matches = stderr.matchAll(/@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9][a-z0-9._-]*/g)
  return [...new Set([...matches].map((m) => m[0]))]
}
