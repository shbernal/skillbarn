/**
 * A line diff, in unified format, with no dependencies.
 *
 * This exists for one caller: `skb update` shows what a new version changes in
 * `SKILL.md` before execution trust is granted to it a second time. That makes the input
 * small and well-behaved — one markdown file, rarely more than a few hundred lines —
 * which is what makes a plain LCS table the right algorithm rather than Myers. `LIMIT`
 * is the backstop for when it is not.
 */
export type Hunk = {
  beforeStart: number
  beforeCount: number
  afterStart: number
  afterCount: number
  /** Lines carrying their unified-format prefix: `' '`, `'-'` or `'+'`. */
  lines: string[]
}

export type Diff = {
  hunks: Hunk[]
  added: number
  removed: number
  /** The texts differ, but by more than `LIMIT` allows describing line by line. */
  truncated: boolean
}

/** Beyond this many cells the LCS table stops being worth its memory. */
const LIMIT = 1_000_000

export function diffLines(before: string, after: string, context = 3): Diff {
  const a = splitLines(before)
  const b = splitLines(after)

  // Equal ends are the bulk of a version bump and cost nothing to skip. Trimming them
  // is also what keeps the table inside LIMIT for all but a wholesale rewrite.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  if (midA.length === 0 && midB.length === 0) {
    return { hunks: [], added: 0, removed: 0, truncated: false }
  }
  if ((midA.length + 1) * (midB.length + 1) > LIMIT) {
    return { hunks: [], added: midB.length, removed: midA.length, truncated: true }
  }

  // The trimmed ends are not diffed, but the `context` lines nearest the change are
  // still what makes the hunk readable, so they are handed back before hunking.
  const unchanged = (line: string): Op => ({ kind: '=', line })
  const lead = a.slice(Math.max(0, head - context), head).map(unchanged)
  const tailStart = a.length - tail
  const trail = a.slice(tailStart, Math.min(a.length, tailStart + context)).map(unchanged)

  return toHunks([...lead, ...align(midA, midB), ...trail], head - lead.length, context)
}

/** One line and what happened to it, in output order. */
type Op = { kind: '=' | '-' | '+'; line: string }

/**
 * Longest common subsequence, then a walk back down it. The table is flat and the reads
 * go through `at` so that an out-of-range index reads as zero rather than as a
 * `number | undefined` every arithmetic expression has to defend against.
 */
function align(a: readonly string[], b: readonly string[]): Op[] {
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  const at = (i: number, j: number): number => table[i * width + j] ?? 0

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: '=', line: a[i] as string })
      i++
      j++
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: '-', line: a[i] as string })
      i++
    } else {
      ops.push({ kind: '+', line: b[j] as string })
      j++
    }
  }
  for (; i < a.length; i++) ops.push({ kind: '-', line: a[i] as string })
  for (; j < b.length; j++) ops.push({ kind: '+', line: b[j] as string })
  return ops
}

/**
 * Gather changed lines into hunks, each padded with `context` unchanged lines. Two
 * changes closer than twice that are one hunk: splitting them would print the lines
 * between twice.
 *
 * `offset` is how many identical lines were trimmed off the front, and exists only so
 * the `@@` headers count from the real file rather than from the slice that was diffed.
 */
function toHunks(ops: readonly Op[], offset: number, context: number): Diff {
  const changed: number[] = []
  let added = 0
  let removed = 0
  for (let i = 0; i < ops.length; i++) {
    const kind = (ops[i] as Op).kind
    if (kind === '=') continue
    changed.push(i)
    if (kind === '+') added++
    else removed++
  }
  if (changed.length === 0) return { hunks: [], added: 0, removed: 0, truncated: false }

  // Line numbers each op sits at, on both sides.
  const beforeAt: number[] = []
  const afterAt: number[] = []
  let before = offset + 1
  let after = offset + 1
  for (const op of ops) {
    beforeAt.push(before)
    afterAt.push(after)
    if (op.kind !== '+') before++
    if (op.kind !== '-') after++
  }
  beforeAt.push(before)
  afterAt.push(after)

  const hunks: Hunk[] = []
  let start = changed[0] as number
  let end = start
  const flush = () => {
    const lo = Math.max(0, start - context)
    const hi = Math.min(ops.length - 1, end + context)
    hunks.push({
      beforeStart: beforeAt[lo] as number,
      beforeCount: (beforeAt[hi + 1] as number) - (beforeAt[lo] as number),
      afterStart: afterAt[lo] as number,
      afterCount: (afterAt[hi + 1] as number) - (afterAt[lo] as number),
      lines: ops.slice(lo, hi + 1).map((op) => `${op.kind === '=' ? ' ' : op.kind}${op.line}`),
    })
  }

  for (const index of changed.slice(1)) {
    if (index - end <= context * 2) {
      end = index
      continue
    }
    flush()
    start = index
    end = index
  }
  flush()

  return { hunks, added, removed, truncated: false }
}

/** The diff as text, one line per entry, ready for a caller to indent. */
export function renderDiff(diff: Diff): string {
  if (diff.truncated) {
    return `(${diff.removed} lines replaced by ${diff.added} — too large to show)`
  }
  const lines: string[] = []
  for (const hunk of diff.hunks) {
    lines.push(
      `@@ -${range(hunk.beforeStart, hunk.beforeCount)} ` +
        `+${range(hunk.afterStart, hunk.afterCount)} @@`,
    )
    lines.push(...hunk.lines)
  }
  return lines.join('\n')
}

/** Unified format counts an empty range from the line before it. */
function range(start: number, count: number): string {
  if (count === 1) return `${start}`
  if (count === 0) return `${start - 1},0`
  return `${start},${count}`
}

/**
 * Lines, without a phantom empty one for a trailing newline. Whether a file ends with a
 * newline is a question for the digest, which hashes bytes; this only has to be read.
 */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export function indentBlock(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : prefix + line))
    .join('\n')
}
