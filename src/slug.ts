import { SkbError } from './errors.ts'

/**
 * A reference to a skill on ClawHub. `owner` is null for a bare slug, which is
 * ambiguous — the registry may host several skills under the same slug — so a bare
 * reference is only ever an input, never something we record.
 */
export type SkillRef = {
  owner: string | null
  slug: string
}

const NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/

/** Parse `@owner/slug` or a bare `slug`. Throws SkbError on anything else. */
export function parseSkillRef(input: string): SkillRef {
  const trimmed = input.trim()
  if (trimmed === '') throw new SkbError('empty skill reference')

  if (trimmed.startsWith('@')) {
    const slash = trimmed.indexOf('/')
    if (slash === -1) {
      throw new SkbError(
        `invalid skill reference: ${input}`,
        'a scoped reference looks like @owner/slug',
      )
    }
    const owner = trimmed.slice(1, slash)
    const slug = trimmed.slice(slash + 1)
    if (!NAME.test(owner) || !NAME.test(slug)) {
      throw new SkbError(`invalid skill reference: ${input}`)
    }
    return { owner, slug }
  }

  if (trimmed.includes('/')) {
    throw new SkbError(
      `invalid skill reference: ${input}`,
      'a scoped reference must start with @, as in @owner/slug',
    )
  }
  if (!NAME.test(trimmed)) throw new SkbError(`invalid skill reference: ${input}`)
  return { owner: null, slug: trimmed }
}

export function formatSkillRef(ref: SkillRef): string {
  return ref.owner === null ? ref.slug : `@${ref.owner}/${ref.slug}`
}

export function isScoped(ref: SkillRef): ref is SkillRef & { owner: string } {
  return ref.owner !== null
}
