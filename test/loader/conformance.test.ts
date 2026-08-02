import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cmdAdd } from '../../src/commands/add.ts'
import { pathExists } from '../../src/fs-tree.ts'
import { type FixtureProject, makeFixtureProject, useEnv } from '../helpers/fixture-project.ts'

/**
 * Why flattening exists, written as a table.
 *
 * ClawHub installs to `<dir>/@owner/slug/`. The Agent Skills spec does not define a
 * scan depth for the skills *root*, and implementations disagree — so a two-level
 * layout is a coin flip per agent. skillbarn produces a tree that satisfies the
 * strictest rule, which the permissive ones accept for free.
 */
type Loader = {
  name: string
  rule: string
  /** Depth below the skills root at which this loader will find a SKILL.md. */
  maxDepth: number
}

const LOADERS: Loader[] = [
  { name: 'Claude Code', rule: 'scans one level: <root>/<skill>/SKILL.md', maxDepth: 1 },
  { name: 'OpenCode', rule: 'globs */SKILL.md', maxDepth: 1 },
  {
    name: 'OpenClaw',
    rule: 'discovers SKILL.md anywhere under a root',
    maxDepth: Number.POSITIVE_INFINITY,
  },
]

/** Skill directories a loader with this rule would find, as paths relative to the root. */
async function discover(root: string, maxDepth: number, prefix = '', depth = 1): Promise<string[]> {
  if (depth > maxDepth) return []
  const found: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (await pathExists(join(dir, 'SKILL.md'))) found.push(relative)
    found.push(...(await discover(dir, maxDepth, relative, depth + 1)))
  }
  return found.sort()
}

let project: FixtureProject
let restoreEnv: () => void

afterEach(async () => {
  restoreEnv?.()
  await project?.dispose()
})

it('produces a tree every documented loader rule accepts, with no duplicates', async () => {
  project = await makeFixtureProject({ localSkills: ['my-local'] })
  restoreEnv = useEnv(project.env)

  for (const ref of ['@fixture/greeter', '@fixture/pdf-filler']) {
    await cmdAdd({ ref, version: undefined, yes: true, force: false, cwd: project.root })
  }

  const expected = ['greeter', 'my-local', 'pdf-filler']
  for (const loader of LOADERS) {
    const found = await discover(project.skillsDir, loader.maxDepth)
    expect(found, `${loader.name} — ${loader.rule}`).toEqual(expected)
    // A recursing loader must not see a nested reference/ directory as a second skill.
    expect(new Set(found).size, `${loader.name} found a duplicate`).toBe(found.length)
  }
})

it('is what an unflattened install would fail', async () => {
  project = await makeFixtureProject({ config: { flatten: false } })
  restoreEnv = useEnv(project.env)
  await cmdAdd({
    ref: '@fixture/greeter',
    version: undefined,
    yes: true,
    force: false,
    cwd: project.root,
  })

  const strict = LOADERS.filter((loader) => loader.maxDepth === 1)
  for (const loader of strict) {
    expect(await discover(project.skillsDir, loader.maxDepth), loader.name).toEqual([])
  }
  const permissive = LOADERS.find((loader) => loader.maxDepth === Number.POSITIVE_INFINITY)
  expect(await discover(project.skillsDir, permissive?.maxDepth ?? 1)).toEqual(['@fixture/greeter'])
})
