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

export type SecuritySummary = {
  status: string | null
  hasWarnings: boolean
  /** Per-scanner verdicts, e.g. `vt`, `skillspector`, `llm`. */
  scanners: Record<string, string>
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

function parseSecurity(raw: unknown): SecuritySummary {
  const security = asRecord(raw)
  if (security === null) return { status: null, hasWarnings: false, scanners: {} }

  const scanners: Record<string, string> = {}
  const scannersRaw = asRecord(security.scanners)
  if (scannersRaw !== null) {
    for (const [name, value] of Object.entries(scannersRaw)) {
      const scanner = asRecord(value)
      if (scanner === null) continue
      const status = asString(scanner.normalizedStatus) ?? asString(scanner.status)
      if (status !== null) scanners[name] = status
    }
  }
  return {
    status: asString(security.status),
    hasWarnings: security.hasWarnings === true,
    scanners,
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
