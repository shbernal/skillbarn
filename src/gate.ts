import type { Diff } from './diff.ts'
import { indentBlock, renderDiff } from './diff.ts'
import { parseFrontmatter } from './frontmatter.ts'
import type { InspectResult, SecuritySummary } from './inspect.ts'
import type { SkillbarnConfig } from './manifest.ts'

/**
 * What a skill's own text says it will do.
 *
 * A best-effort scan, not a sandbox analysis: these exist to make an unusual skill
 * *look* unusual, and every rendering of them says so. Split out from `SkillSummary`
 * because `skb update` computes one for the installed `SKILL.md` as well, so it can say
 * which of them the new version *adds*.
 */
export type SkillText = {
  allowedTools: string[]
  commands: string[]
  envVars: string[]
}

export function summarizeSkillText(source: string): SkillText {
  const { frontmatter, body } = parseFrontmatter(source)
  return {
    allowedTools: toList(frontmatter['allowed-tools'] ?? frontmatter.allowed_tools),
    commands: extractCommands(body),
    envVars: extractEnvVars(body),
  }
}

/** What `after` mentions that `before` did not. Empty in all three is the quiet case. */
export function newlyMentioned(before: SkillText, after: SkillText): SkillText {
  const added = (was: readonly string[], now: readonly string[]) => {
    const seen = new Set(was)
    return now.filter((item) => !seen.has(item))
  }
  return {
    allowedTools: added(before.allowedTools, after.allowedTools),
    commands: added(before.commands, after.commands),
    envVars: added(before.envVars, after.envVars),
  }
}

export function isEmptyText(text: SkillText): boolean {
  return text.allowedTools.length === 0 && text.commands.length === 0 && text.envVars.length === 0
}

/**
 * What `skb add` shows before installing anything, and `skb update` before replacing it.
 *
 * The payload is instructions an agent will execute, and the whole point of gitignoring
 * it is that nobody opens it again — so the one moment it gets read is here.
 */
export type SkillSummary = SkillText & {
  ref: string
  displayName: string
  version: string
  license: string | null
  summary: string
  fileCount: number
  totalBytes: number
  declaredName: string | null
  security: SecuritySummary
}

export function summarizeSkill(inspected: InspectResult): SkillSummary {
  const { frontmatter, body } = parseFrontmatter(inspected.description)
  const declaredName = typeof frontmatter.name === 'string' ? frontmatter.name : null

  return {
    ...summarizeSkillText(inspected.description),
    ref: `@${inspected.owner}/${inspected.slug}`,
    displayName: inspected.displayName,
    version: inspected.version,
    license: inspected.license,
    summary: inspected.summary || firstParagraph(body),
    fileCount: inspected.files.length,
    totalBytes: inspected.files.reduce((sum, f) => sum + f.size, 0),
    declaredName,
    security: inspected.security,
  }
}

/** Frontmatter values arrive as a scalar or a sequence depending on how they were written. */
function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  if (Array.isArray(value)) return value
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

const FENCE = /^```([A-Za-z0-9_+-]*)[ \t]*$/
const SHELL_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'shell-session'])

/** Leading executables of shell-fenced lines — what the skill tells an agent to run. */
export function extractCommands(body: string): string[] {
  const found = new Set<string>()
  let inShellFence = false
  let fenceLang = ''

  for (const line of body.split('\n')) {
    const fence = FENCE.exec(line.trim())
    if (fence !== null) {
      if (inShellFence || fenceLang !== '') {
        inShellFence = false
        fenceLang = ''
      } else {
        fenceLang = (fence[1] ?? '').toLowerCase()
        inShellFence = SHELL_LANGS.has(fenceLang)
        if (fenceLang === '') inShellFence = false
      }
      continue
    }
    if (!inShellFence) continue

    const stripped = line.trim().replace(/^\$\s+/, '')
    const word = /^([A-Za-z_][A-Za-z0-9_.-]*)\b/.exec(stripped)
    if (word === null) continue
    const command = word[1] as string
    // Shell keywords and assignments are noise, not capabilities.
    if (SHELL_NOISE.has(command) || stripped.startsWith(`${command}=`)) continue
    found.add(command)
  }
  return [...found].sort()
}

const SHELL_NOISE = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'return',
  'exit',
  'local',
  'export',
  'set',
  'echo',
  'cd',
  'true',
  'false',
])

const ENV_PATTERNS = [
  /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g,
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g,
  /os\.environ(?:\.get)?[[(]['"]([A-Z][A-Z0-9_]{2,})['"]/g,
]

export function extractEnvVars(body: string): string[] {
  const found = new Set<string>()
  for (const pattern of ENV_PATTERNS) {
    for (const match of body.matchAll(pattern)) {
      const name = match[1]
      if (name !== undefined && !ENV_NOISE.has(name)) found.add(name)
    }
  }
  return [...found].sort()
}

const ENV_NOISE = new Set(['PWD', 'PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'PS1'])

function firstParagraph(body: string): string {
  const paragraph = body.trim().split(/\n\s*\n/)[0] ?? ''
  return paragraph
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The block `skb add` prints above the skill summary when the project has no manifest
 * yet, so the settings about to take effect are read once rather than inherited silently.
 *
 * It rides the confirmation `add` already asks rather than adding a second prompt: the
 * existing gate is default-no because the payload is instructions an agent will execute,
 * and two prompts in a row is how that one stops being read.
 */
export function renderProjectCreation(manifestPath: string, config: SkillbarnConfig): string {
  return [
    `  no skillbarn project here yet — this will create ${manifestPath}`,
    '',
    `    dir        ${config.dir}`,
    `    flatten    ${config.flatten}`,
    `    gitignore  ${config.gitignore}`,
    '',
    '  every field is optional and editable afterwards; see the README.',
  ].join('\n')
}

/** The block `skb add` prints before asking for confirmation. */
export function renderSummary(summary: SkillSummary): string {
  const lines = alarm(summary.security)
  lines.push(`  ${summary.ref}@${summary.version}  ${summary.displayName}`)
  if (summary.license !== null) lines.push(`  license   ${summary.license}`)
  lines.push(`  files     ${summary.fileCount} (${formatBytes(summary.totalBytes)})`)
  if (summary.declaredName !== null && summary.declaredName !== summary.ref.split('/')[1]) {
    lines.push(`  declares  name: ${summary.declaredName}`)
  }
  lines.push(...scanLines(summary.security))

  if (summary.summary !== '') {
    lines.push('')
    lines.push(wrap(summary.summary, 74, '  '))
  }

  lines.push('')
  lines.push(...mentions('mentioned in the skill text', summary))
  lines.push(...scanNotes(summary.security))

  return lines.join('\n')
}

/**
 * The block `skb update` prints before replacing a version that is already installed.
 *
 * It is deliberately the same shape as the add gate, because it asks the same question:
 * ClawHub publishing is open, so a new version is a second grant of execution trust to
 * whoever holds the account, not a continuation of the first. What it adds is the two
 * things only an update can show — the `SKILL.md` diff, and which commands and
 * environment variables the new text mentions that the installed one did not.
 */
export function renderUpdate(
  summary: SkillSummary,
  from: string,
  installed: SkillText,
  diff: Diff,
): string {
  const lines = alarm(summary.security)
  lines.push(
    from === summary.version
      ? `  ${summary.ref}  ${from} republished — same version, different bytes`
      : `  ${summary.ref}  ${from} -> ${summary.version}`,
  )
  if (summary.license !== null) lines.push(`  license   ${summary.license}`)
  lines.push(`  files     ${summary.fileCount} (${formatBytes(summary.totalBytes)})`)
  lines.push(...scanLines(summary.security))

  const added = newlyMentioned(installed, summary)
  if (!isEmptyText(added)) {
    lines.push('')
    lines.push(...mentions('newly mentioned in the skill text', added))
  }
  lines.push(...scanNotes(summary.security))

  lines.push('')
  if (diff.hunks.length === 0 && !diff.truncated) {
    lines.push('  SKILL.md is unchanged; other files in the skill are not.')
  } else {
    lines.push(`  SKILL.md  +${diff.added} -${diff.removed}`)
    lines.push(indentBlock(renderDiff(diff), '  '))
  }
  return lines.join('\n')
}

/** A version the registry's own scanners did not clear is said once, at the top. */
function alarm(security: SecuritySummary): string[] {
  const status = security.status
  if (status === null || status === 'clean') return []
  return [`  !! ClawHub's scanners did not clear this version — status: ${status}`, '']
}

function scanLines(security: SecuritySummary): string[] {
  const lines: string[] = []
  const scan = Object.entries(security.scanners)
    .map(([name, status]) => `${name}=${status}`)
    .join(' ')
  if (security.status !== null || scan !== '') {
    const warned = security.hasWarnings ? ', with warnings' : ''
    lines.push(
      `  scans     ${security.status ?? 'unknown'}${warned}${scan === '' ? '' : ` (${scan})`}`,
    )
  }
  if (security.severity !== null) lines.push(`  severity  ${security.severity}`)
  return lines
}

/**
 * The scanners' own reasoning, not just their verdict.
 *
 * `hasWarnings` is true for plenty of skills that are entirely fine — the live
 * `@shbernal/rfc-lookup` is one — so a bare warning flag trains people to ignore it.
 * Printing what was actually flagged is what makes the flag worth reading.
 */
function scanNotes(security: SecuritySummary): string[] {
  const lines: string[] = []
  if (security.notes.length > 0) {
    lines.push('')
    lines.push("  flagged by ClawHub's scanners:")
    for (const note of security.notes) {
      lines.push(`    ${note.label} — ${note.rating}`)
      if (note.detail !== '') lines.push(wrap(note.detail, 70, '      '))
    }
  }
  if (security.guidance !== null && security.guidance !== '') {
    lines.push('')
    lines.push(wrap(`before installing: ${security.guidance}`, 74, '  '))
  }
  return lines
}

function mentions(heading: string, text: SkillText): string[] {
  const row = (label: string, items: readonly string[]) =>
    `    ${label.padEnd(9)} ${items.length > 0 ? items.join(', ') : '—'}`
  return [
    `  ${heading} (heuristic, not a sandbox report):`,
    row('tools', text.allowedTools),
    row('commands', text.commands),
    row('env vars', text.envVars),
  ]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current === '') current = word
    else if (current.length + 1 + word.length <= width) current += ` ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current !== '') lines.push(current)
  return lines.map((line) => indent + line).join('\n')
}
