export const GITIGNORE_HEADER = '# managed by skillbarn — do not edit'

/**
 * Render `<dir>/.gitignore` from the lock's slugs. The file is owned, never merged:
 * every vendored skill is ignored, everything else in the directory (hand-authored
 * skills, this file itself) stays visible to git.
 */
export function renderGitignore(slugs: readonly string[]): string {
  const unique = [...new Set(slugs)].sort()
  const lines = [GITIGNORE_HEADER, ...unique.map((slug) => `/${slug}/`)]
  return `${lines.join('\n')}\n`
}
