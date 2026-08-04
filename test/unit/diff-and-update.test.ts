import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { diffLines, indentBlock, renderDiff } from '../../src/diff.ts'
import { renderUpdate, summarizeSkill, summarizeSkillText } from '../../src/gate.ts'
import { parseInspectJson } from '../../src/inspect.ts'
import { emptyLock, type LockEntry, reconcile } from '../../src/lock.ts'
import { emptyManifest, type Manifest } from '../../src/manifest.ts'
import { classify, manifestIntegrity } from '../../src/update.ts'

const line = fc.stringMatching(/^[a-z ]{0,12}$/)
const text = fc.array(line, { maxLength: 40 }).map((lines) => lines.map((l) => `${l}\n`).join(''))

describe('the SKILL.md diff', () => {
  it('reports nothing at all when the text has not moved', () => {
    fc.assert(
      fc.property(text, (source) => {
        expect(diffLines(source, source)).toEqual({
          hunks: [],
          added: 0,
          removed: 0,
          truncated: false,
        })
      }),
    )
  })

  // The counts are what `skb update` puts in its one-line header, so a wrong one is a
  // lie about the size of the change being accepted.
  it('counts every line it shows, and shows only lines that exist', () => {
    fc.assert(
      fc.property(text, text, (before, after) => {
        const diff = diffLines(before, after)
        const shown = diff.hunks.flatMap((hunk) => hunk.lines)
        const removed = shown.filter((l) => l.startsWith('-')).map((l) => l.slice(1))
        const added = shown.filter((l) => l.startsWith('+')).map((l) => l.slice(1))

        expect(removed.length).toBe(diff.removed)
        expect(added.length).toBe(diff.added)
        for (const l of removed) expect(before.split('\n')).toContain(l)
        for (const l of added) expect(after.split('\n')).toContain(l)
      }),
    )
  })

  it('says something whenever the text moved at all', () => {
    fc.assert(
      fc.property(text, text, (before, after) => {
        fc.pre(before !== after)
        const diff = diffLines(before, after)
        expect(diff.hunks.length > 0 || diff.truncated).toBe(true)
      }),
    )
  })

  it('renders exactly these bytes', () => {
    const before = [
      '---',
      'name: greeter',
      'version: 1.2.0',
      '---',
      '',
      'Greets a person.',
      '',
    ].join('\n')
    const after = [
      '---',
      'name: greeter',
      'version: 1.3.0',
      '---',
      '',
      'Greets a person.',
      '',
      'Now with telemetry.',
      '',
    ].join('\n')

    // Written out rather than snapshotted: a context line standing in for a blank line
    // is a single space, and every formatter in the toolchain would strip it from a
    // snapshot literal.
    expect(renderDiff(diffLines(before, after))).toBe(
      [
        '@@ -1,6 +1,8 @@',
        ' ---',
        ' name: greeter',
        '-version: 1.2.0',
        '+version: 1.3.0',
        ' ---',
        ' ',
        ' Greets a person.',
        '+',
        '+Now with telemetry.',
      ].join('\n'),
    )
  })

  it('numbers an insertion into an empty file from zero, as unified format does', () => {
    expect(renderDiff(diffLines('', 'one\ntwo\n'))).toBe('@@ -0,0 +1,2 @@\n+one\n+two')
    expect(renderDiff(diffLines('one\ntwo\n', ''))).toBe('@@ -1,2 +0,0 @@\n-one\n-two')
  })

  it('keeps distant changes in separate hunks and close ones together', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const near = before.replace('line 1\n', 'CHANGED 1\n').replace('line 3\n', 'CHANGED 3\n')
    const far = before.replace('line 1\n', 'CHANGED 1\n').replace('line 30\n', 'CHANGED 30\n')

    expect(diffLines(before, near).hunks).toHaveLength(1)
    expect(diffLines(before, far).hunks).toHaveLength(2)
  })

  it('gives up rather than build a table it cannot afford', () => {
    const before = Array.from({ length: 1500 }, (_, i) => `a${i}`).join('\n')
    const after = Array.from({ length: 1500 }, (_, i) => `b${i}`).join('\n')
    const diff = diffLines(before, after)
    expect(diff.truncated).toBe(true)
    expect(renderDiff(diff)).toBe('(1500 lines replaced by 1500 — too large to show)')
  })

  it('indents without putting whitespace on blank lines', () => {
    expect(indentBlock('a\n\nb', '  ')).toBe('  a\n\n  b')
  })
})

function entry(overrides: Partial<LockEntry> = {}): LockEntry {
  return {
    source: 'clawhub',
    owner: 'fixture',
    slug: 'greeter',
    version: '1.2.0',
    path: '.agents/skills/greeter',
    integrity: `sha256-${'0'.repeat(64)}`,
    ...overrides,
  }
}

function inspected(version: string, files: { path: string; sha256: string }[]) {
  return parseInspectJson(
    JSON.stringify({
      skill: { slug: 'greeter', description: '---\nname: greeter\n---\n' },
      owner: { handle: 'fixture' },
      version: { version, files: files.map((f) => ({ ...f, size: 1 })) },
    }),
  )
}

describe('classifying a locked skill against the registry', () => {
  const files = [{ path: 'SKILL.md', sha256: 'aa' }]

  it('calls a version that has not moved, with bytes that have not either, current', () => {
    const locked = entry({ integrity: manifestIntegrity(inspected('1.2.0', files)) })
    expect(classify(locked, inspected('1.2.0', files)).status).toBe('current')
  })

  it('calls a new version outdated', () => {
    expect(classify(entry(), inspected('1.3.0', files)).status).toBe('outdated')
  })

  // The case a version-string comparison cannot see, and the reason the integrity is
  // computed from the registry manifest rather than from a download.
  it('calls the same version with different bytes republished', () => {
    const locked = entry({ integrity: manifestIntegrity(inspected('1.2.0', files)) })
    const republished = inspected('1.2.0', [{ path: 'SKILL.md', sha256: 'bb' }])
    expect(classify(locked, republished).status).toBe('republished')
  })

  it('ignores what the digest ignores, so a rewritten _meta.json is not a republication', () => {
    const locked = entry({ integrity: manifestIntegrity(inspected('1.2.0', files)) })
    const withMeta = inspected('1.2.0', [...files, { path: '_meta.json', sha256: 'anything' }])
    expect(classify(locked, withMeta).status).toBe('current')
  })
})

describe('manifest and lock disagreeing about a version', () => {
  const manifest = (version?: string): Manifest => ({
    ...emptyManifest(),
    skills: {
      '@fixture/greeter':
        version === undefined ? { source: 'clawhub' } : { source: 'clawhub', version },
    },
  })
  const lock = () => {
    const built = emptyLock()
    built.skills.greeter = entry()
    return built
  }

  it('is reported, pointing at the command that would settle it', () => {
    expect(reconcile(manifest('2.0.0'), lock()).versionDrift).toEqual([
      { slug: 'greeter', declared: '2.0.0', locked: '1.2.0' },
    ])
  })

  it('is not reported when they agree', () => {
    expect(reconcile(manifest('1.2.0'), lock()).versionDrift).toEqual([])
  })

  // "whatever was latest when it was added" is a question the lock answers, not one it
  // can contradict.
  it('is not reported when the declaration names no version', () => {
    expect(reconcile(manifest(), lock()).versionDrift).toEqual([])
  })
})

describe('the scan report', () => {
  const report = (security: unknown) =>
    parseInspectJson(
      JSON.stringify({
        skill: { slug: 'greeter', description: '---\nname: greeter\n---\n' },
        owner: { handle: 'fixture' },
        version: { version: '1.0.0', files: [], security },
      }),
    ).security

  it('keeps the severity, the flagged dimensions and the guidance', () => {
    const security = report({
      status: 'clean',
      hasWarnings: true,
      scanners: {
        skillspector: { normalizedStatus: 'clean', severity: 'LOW' },
        llm: {
          normalizedStatus: 'clean',
          guidance: 'read the sync command before running it',
          dimensions: [
            { label: 'Install Mechanism', rating: 'ok', detail: 'nothing to install' },
            { label: 'Credentials', rating: 'note', detail: 'reads RFC_MIRROR' },
          ],
        },
      },
    })

    expect(security.hasWarnings).toBe(true)
    expect(security.severity).toBe('LOW')
    expect(security.guidance).toBe('read the sync command before running it')
    // `ok` is the overwhelming majority; printing it would bury the one that matters.
    expect(security.notes).toEqual([
      { label: 'Credentials', rating: 'note', detail: 'reads RFC_MIRROR' },
    ])
  })

  it('reads a report with none of that as an empty one rather than failing', () => {
    expect(report({ status: 'clean', scanners: { vt: { status: 'clean' } } })).toEqual({
      status: 'clean',
      hasWarnings: false,
      scanners: { vt: 'clean' },
      severity: null,
      notes: [],
      guidance: null,
    })
    expect(report(undefined).status).toBeNull()
  })
})

describe('the update gate', () => {
  const source = (version: string, extra = '') =>
    `---\nname: greeter\nversion: ${version}\nallowed-tools: [Read]\n---\n\n# Greeter\n\n\`\`\`bash\njq -r .name x.json\n${extra}\`\`\`\n`

  const summaryFor = (version: string, extra = '', security: unknown = { status: 'clean' }) =>
    summarizeSkill(
      parseInspectJson(
        JSON.stringify({
          skill: { slug: 'greeter', displayName: 'Greeter', description: source(version, extra) },
          owner: { handle: 'fixture' },
          version: {
            version,
            license: 'MIT',
            files: [{ path: 'SKILL.md', sha256: 'a', size: 300 }],
            security,
          },
        }),
      ),
    )

  it('names what the new text mentions and the old one did not', () => {
    const rendered = renderUpdate(
      summaryFor('1.3.0', 'curl -s "$TELEMETRY_URL/ping"\n'),
      '1.2.0',
      summarizeSkillText(source('1.2.0')),
      diffLines(source('1.2.0'), source('1.3.0', 'curl -s "$TELEMETRY_URL/ping"\n')),
    )
    expect(rendered).toContain('@fixture/greeter  1.2.0 -> 1.3.0')
    expect(rendered).toContain('newly mentioned in the skill text')
    expect(rendered).toContain('commands  curl')
    expect(rendered).toContain('env vars  TELEMETRY_URL')
    expect(rendered).toContain('+curl -s "$TELEMETRY_URL/ping"')
    // `jq` was already there; repeating it would bury the one that is new.
    expect(rendered).not.toContain('commands  curl, jq')
  })

  it('says so plainly when only the bytes moved', () => {
    const rendered = renderUpdate(
      summaryFor('1.2.0', 'rm -rf /\n'),
      '1.2.0',
      summarizeSkillText(source('1.2.0')),
      diffLines(source('1.2.0'), source('1.2.0', 'rm -rf /\n')),
    )
    expect(rendered).toContain('1.2.0 republished — same version, different bytes')
  })

  it('leads with a version the scanners did not clear', () => {
    const rendered = renderUpdate(
      summaryFor('1.3.0', '', { status: 'flagged', hasWarnings: true }),
      '1.2.0',
      summarizeSkillText(source('1.2.0')),
      diffLines(source('1.2.0'), source('1.3.0')),
    )
    expect(rendered.split('\n')[0]).toContain("ClawHub's scanners did not clear this version")
    expect(rendered).toContain('scans     flagged, with warnings')
  })

  it('does not pretend nothing changed when SKILL.md happens not to have', () => {
    const rendered = renderUpdate(
      summaryFor('1.3.0'),
      '1.2.0',
      summarizeSkillText(source('1.3.0')),
      diffLines(source('1.3.0'), source('1.3.0')),
    )
    expect(rendered).toContain('SKILL.md is unchanged; other files in the skill are not.')
  })
})
