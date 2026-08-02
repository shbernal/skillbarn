import { parseFrontmatter } from './frontmatter.ts'
import type { InspectResult } from './inspect.ts'

/**
 * What `skb add` shows before installing anything.
 *
 * The payload is instructions an agent will execute, and the whole point of
 * gitignoring it is that nobody opens it again — so the one moment it gets read is
 * here. `commands` and `envVars` are a best-effort scan of the skill's own text, not a
 * sandbox analysis: they exist to make an unusual skill *look* unusual, and are
 * labelled as such in the rendered summary.
 */
export type SkillSummary = {
  ref: string
  displayName: string
  version: string
  license: string | null
  summary: string
  fileCount: number
  totalBytes: number
  declaredName: string | null
  allowedTools: string[]
  commands: string[]
  envVars: string[]
  security: { status: string | null; hasWarnings: boolean; scanners: Record<string, string> }
}

export function summarizeSkill(inspected: InspectResult): SkillSummary {
  const { frontmatter, body } = parseFrontmatter(inspected.description)
  const declaredName = typeof frontmatter.name === 'string' ? frontmatter.name : null

  return {
    ref: `@${inspected.owner}/${inspected.slug}`,
    displayName: inspected.displayName,
    version: inspected.version,
    license: inspected.license,
    summary: inspected.summary || firstParagraph(body),
    fileCount: inspected.files.length,
    totalBytes: inspected.files.reduce((sum, f) => sum + f.size, 0),
    declaredName,
    allowedTools: toList(frontmatter['allowed-tools'] ?? frontmatter.allowed_tools),
    commands: extractCommands(body),
    envVars: extractEnvVars(body),
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

/** The block `skb add` prints before asking for confirmation. */
export function renderSummary(summary: SkillSummary): string {
  const lines: string[] = []
  lines.push(`  ${summary.ref}@${summary.version}  ${summary.displayName}`)
  if (summary.license !== null) lines.push(`  license   ${summary.license}`)
  lines.push(`  files     ${summary.fileCount} (${formatBytes(summary.totalBytes)})`)
  if (summary.declaredName !== null && summary.declaredName !== summary.ref.split('/')[1]) {
    lines.push(`  declares  name: ${summary.declaredName}`)
  }

  const scan = Object.entries(summary.security.scanners)
    .map(([name, status]) => `${name}=${status}`)
    .join(' ')
  if (summary.security.status !== null || scan !== '') {
    lines.push(
      `  scans     ${summary.security.status ?? 'unknown'}${scan === '' ? '' : ` (${scan})`}`,
    )
  }

  if (summary.summary !== '') {
    lines.push('')
    lines.push(wrap(summary.summary, 74, '  '))
  }

  lines.push('')
  lines.push('  mentioned in the skill text (heuristic, not a sandbox report):')
  lines.push(
    `    tools     ${summary.allowedTools.length > 0 ? summary.allowedTools.join(', ') : '—'}`,
  )
  lines.push(`    commands  ${summary.commands.length > 0 ? summary.commands.join(', ') : '—'}`)
  lines.push(`    env vars  ${summary.envVars.length > 0 ? summary.envVars.join(', ') : '—'}`)

  return lines.join('\n')
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
