/**
 * Minimal YAML frontmatter reader — enough for the `SKILL.md` header, no more.
 *
 * Handles `key: value`, `key: |`/`key: >` block scalars and `- item` sequences, which
 * is what the Agent Skills spec's frontmatter uses. Anything nested is returned as its
 * raw text: the gate only ever displays these values, so a partial parse is honest
 * output rather than a wrong one, and it keeps the dependency count at zero.
 */
export type Frontmatter = Record<string, string | string[]>

export type ParsedDocument = {
  frontmatter: Frontmatter
  body: string
}

const DELIMITER = /^---[ \t]*$/

export function parseFrontmatter(text: string): ParsedDocument {
  const lines = text.split('\n')
  if (lines[0] === undefined || !DELIMITER.test(lines[0])) {
    return { frontmatter: {}, body: text }
  }

  const end = lines.findIndex((line, i) => i > 0 && DELIMITER.test(line))
  if (end === -1) return { frontmatter: {}, body: text }

  return {
    frontmatter: parseBlock(lines.slice(1, end)),
    body: lines.slice(end + 1).join('\n'),
  }
}

function parseBlock(lines: readonly string[]): Frontmatter {
  const out: Frontmatter = {}
  let key: string | null = null
  let scalar: string[] | null = null
  let sequence: string[] | null = null

  const flush = () => {
    if (key === null) return
    if (scalar !== null) out[key] = trimBlank(scalar).join('\n')
    else if (sequence !== null) out[key] = sequence
    key = null
    scalar = null
    sequence = null
  }

  for (const line of lines) {
    const indented = /^[ \t]/.test(line)

    if (scalar !== null && (indented || line.trim() === '')) {
      scalar.push(line.replace(/^[ \t]{1,2}/, ''))
      continue
    }
    if (sequence !== null && indented) {
      const item = line.trim()
      if (item.startsWith('- ')) {
        sequence.push(unquote(item.slice(2).trim()))
        continue
      }
    }

    const match = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line)
    if (match === null) continue
    flush()
    key = match[1] as string
    const value = (match[2] ?? '').trim()

    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      scalar = []
    } else if (value === '') {
      sequence = []
    } else if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = splitInline(value.slice(1, -1))
      key = null
    } else {
      out[key] = unquote(value)
      key = null
    }
  }
  flush()
  return out
}

function splitInline(inner: string): string[] {
  return inner
    .split(',')
    .map((part) => unquote(part.trim()))
    .filter((part) => part !== '')
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1)
  }
  return value
}

function trimBlank(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim() === '') start++
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--
  return lines.slice(start, end)
}
