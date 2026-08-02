import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  compareFileHashes,
  excludeFromDigest,
  type FileHash,
  isDigestExcluded,
  treeDigest,
} from '../../src/digest.ts'
import { SkbError } from '../../src/errors.ts'
import { GITIGNORE_HEADER, renderGitignore } from '../../src/gitignore.ts'
import {
  emptyLock,
  type Lock,
  type LockEntry,
  parseLock,
  reconcile,
  renderLock,
} from '../../src/lock.ts'
import { type Manifest, parseManifest, renderManifest } from '../../src/manifest.ts'
import { formatSkillRef, parseSkillRef } from '../../src/slug.ts'

const name = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,20}$/).filter((s) => /[a-z0-9]$/.test(s))

const scopedRef = fc.tuple(name, name).map(([owner, slug]) => `@${owner}/${slug}`)

const hex64 = fc.string({
  unit: fc.constantFrom(...'0123456789abcdef'),
  minLength: 64,
  maxLength: 64,
})

const fileHash = fc.record({
  path: fc
    .array(fc.stringMatching(/^[a-z0-9_-]{1,8}$/), { minLength: 1, maxLength: 3 })
    .map((parts) => parts.join('/')),
  sha256: hex64,
})

describe('slug parsing', () => {
  it('round-trips every reference it accepts', () => {
    fc.assert(
      fc.property(scopedRef, (ref) => {
        expect(formatSkillRef(parseSkillRef(ref))).toBe(ref)
      }),
    )
  })

  it('round-trips bare slugs', () => {
    fc.assert(
      fc.property(name, (slug) => {
        const parsed = parseSkillRef(slug)
        expect(parsed.owner).toBeNull()
        expect(formatSkillRef(parsed)).toBe(slug)
      }),
    )
  })

  it('rejects an owner without a slug', () => {
    expect(() => parseSkillRef('@owner')).toThrow(SkbError)
    expect(() => parseSkillRef('owner/slug')).toThrow(SkbError)
    expect(() => parseSkillRef('')).toThrow(SkbError)
    expect(() => parseSkillRef('@owner/')).toThrow(SkbError)
    expect(() => parseSkillRef('../escape')).toThrow(SkbError)
  })
})

describe('digest', () => {
  it('does not depend on the order files were discovered in', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fileHash, { selector: (f) => f.path }), (files) => {
        const shuffled = [...files].reverse()
        expect(treeDigest(shuffled)).toBe(treeDigest(files))
      }),
    )
  })

  it('separates path from content, so no two distinct trees collide', () => {
    const a: FileHash[] = [
      { path: 'a', sha256: 'ff' },
      { path: 'b', sha256: 'ee' },
    ]
    const b: FileHash[] = [
      { path: 'a', sha256: 'ee' },
      { path: 'b', sha256: 'ff' },
    ]
    expect(treeDigest(a)).not.toBe(treeDigest(b))
  })

  it('changes when any file changes', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fileHash, { minLength: 1, selector: (f) => f.path }),
        hex64,
        (files, replacement) => {
          const first = files[0] as FileHash
          fc.pre(first.sha256 !== replacement)
          const changed = [{ ...first, sha256: replacement }, ...files.slice(1)]
          expect(treeDigest(changed)).not.toBe(treeDigest(files))
        },
      ),
    )
  })

  it('excludes what ClawHub rewrites locally', () => {
    expect(isDigestExcluded('_meta.json')).toBe(true)
    expect(isDigestExcluded('.clawhub/origin.json')).toBe(true)
    expect(isDigestExcluded('SKILL.md')).toBe(false)
    expect(isDigestExcluded('reference/_meta.json')).toBe(false)
    expect(excludeFromDigest([{ path: '_meta.json', sha256: 'aa' }])).toEqual([])
  })

  it('reports every disagreement with a registry manifest, in both directions', () => {
    const mismatches = compareFileHashes(
      [
        { path: 'SKILL.md', sha256: 'aa' },
        { path: 'gone.md', sha256: 'bb' },
        { path: '_meta.json', sha256: 'ignored' },
      ],
      [
        { path: 'SKILL.md', sha256: 'ZZ' },
        { path: 'extra.md', sha256: 'cc' },
        { path: '_meta.json', sha256: 'different' },
      ],
    )
    expect(mismatches).toEqual([
      { path: 'SKILL.md', expected: 'aa', actual: 'ZZ' },
      { path: 'extra.md', expected: null, actual: 'cc' },
      { path: 'gone.md', expected: 'bb', actual: null },
    ])
  })
})

describe('gitignore rendering', () => {
  it('is idempotent and order-independent', () => {
    fc.assert(
      fc.property(fc.array(name), (slugs) => {
        const once = renderGitignore(slugs)
        expect(renderGitignore([...slugs].reverse())).toBe(once)
        expect(renderGitignore([...slugs, ...slugs])).toBe(once)
      }),
    )
  })

  it('always carries the ownership header and ends with a newline', () => {
    fc.assert(
      fc.property(fc.array(name), (slugs) => {
        const rendered = renderGitignore(slugs)
        expect(rendered.startsWith(GITIGNORE_HEADER)).toBe(true)
        expect(rendered.endsWith('\n')).toBe(true)
      }),
    )
  })

  it('renders exactly these bytes', () => {
    expect(renderGitignore(['pdf-filler', 'humanizer'])).toMatchInlineSnapshot(`
      "# managed by skillbarn — do not edit
      /humanizer/
      /pdf-filler/
      "
    `)
  })

  it('renders an empty lock as the header alone', () => {
    expect(renderGitignore([])).toBe(`${GITIGNORE_HEADER}\n`)
  })
})

function entry(slug: string, owner = 'fixture'): LockEntry {
  return {
    source: 'clawhub',
    owner,
    slug,
    version: '1.0.0',
    path: `.agents/skills/${slug}`,
    integrity: `sha256-${'0'.repeat(64)}`,
  }
}

describe('lock and manifest', () => {
  it('round-trips through render and parse', () => {
    fc.assert(
      fc.property(fc.uniqueArray(name), fc.uniqueArray(name), (slugs, owners) => {
        const lock: Lock = emptyLock()
        for (const [i, slug] of slugs.entries()) {
          lock.skills[slug] = entry(slug, owners[i % Math.max(owners.length, 1)] ?? 'fixture')
        }
        expect(parseLock(renderLock(lock))).toEqual(lock)
      }),
    )
  })

  it('renders stable bytes regardless of insertion order', () => {
    const a = emptyLock()
    a.skills.zeta = entry('zeta')
    a.skills.alpha = entry('alpha')
    const b = emptyLock()
    b.skills.alpha = entry('alpha')
    b.skills.zeta = entry('zeta')
    expect(renderLock(a)).toBe(renderLock(b))
  })

  it('renders exactly these bytes', () => {
    const lock = emptyLock()
    lock.skills.greeter = {
      source: 'clawhub',
      owner: 'fixture',
      slug: 'greeter',
      version: '1.2.0',
      path: '.agents/skills/greeter',
      integrity: 'sha256-abc',
    }
    expect(renderLock(lock)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 1,
        "skills": {
          "greeter": {
            "source": "clawhub",
            "owner": "fixture",
            "slug": "greeter",
            "version": "1.2.0",
            "path": ".agents/skills/greeter",
            "integrity": "sha256-abc"
          }
        }
      }
      "
    `)
  })

  it('refuses a lockfile from a newer skillbarn', () => {
    expect(() => parseLock('{"lockfileVersion": 99, "skills": {}}')).toThrow(SkbError)
  })

  it('refuses a manifest entry without an owner', () => {
    expect(() => parseManifest('{"skills": {"greeter": {}}}')).toThrow(SkbError)
  })

  it('round-trips a manifest', () => {
    fc.assert(
      fc.property(fc.uniqueArray(scopedRef), (refs) => {
        const manifest: Manifest = { skills: {} }
        for (const ref of refs) manifest.skills[ref] = { source: 'clawhub', version: '1.0.0' }
        expect(parseManifest(renderManifest(manifest))).toEqual(manifest)
      }),
    )
  })
})

describe('reconcile', () => {
  it('converges: a lock built from the manifest reports no difference', () => {
    fc.assert(
      fc.property(fc.uniqueArray(name), (slugs) => {
        const manifest: Manifest = { skills: {} }
        const lock = emptyLock()
        for (const slug of slugs) {
          manifest.skills[`@fixture/${slug}`] = { source: 'clawhub', version: '1.0.0' }
          lock.skills[slug] = entry(slug)
        }
        const result = reconcile(manifest, lock)
        expect(result.missingFromLock).toEqual([])
        expect(result.staleInLock).toEqual([])
        expect(result.restore).toHaveLength(slugs.length)
      }),
    )
  })

  it('restores the lock, not the manifest', () => {
    const manifest: Manifest = { skills: { '@fixture/wanted': { source: 'clawhub' } } }
    const lock = emptyLock()
    lock.skills.locked = entry('locked')

    const result = reconcile(manifest, lock)
    expect(result.restore.map((e) => e.slug)).toEqual(['locked'])
    expect(result.missingFromLock).toEqual(['@fixture/wanted'])
    expect(result.staleInLock).toEqual(['locked'])
  })

  it('is stable under repetition', () => {
    const manifest: Manifest = { skills: { '@fixture/a': { source: 'clawhub' } } }
    const lock = emptyLock()
    lock.skills.b = entry('b')
    expect(reconcile(manifest, lock)).toEqual(reconcile(manifest, lock))
  })
})
