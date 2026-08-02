import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cmdAdd } from '../../src/commands/add.ts'
import { cmdInstall } from '../../src/commands/install.ts'
import { cmdVerify } from '../../src/commands/verify.ts'
import { pathExists } from '../../src/fs-tree.ts'
import { checkInvariants } from '../../src/invariants.ts'
import { type FixtureProject, makeFixtureProject, useEnv } from '../helpers/fixture-project.ts'

/**
 * Failure modes the live registry cannot be asked to produce on demand. Each one is a
 * check in the implementation that would otherwise never be exercised.
 */
let project: FixtureProject
let restoreEnv: () => void

afterEach(async () => {
  restoreEnv?.()
  await project?.dispose()
})

async function setup(options: Parameters<typeof makeFixtureProject>[0] = {}): Promise<void> {
  project = await makeFixtureProject({ localSkills: ['my-local'], ...options })
  restoreEnv = useEnv(project.env)
}

const add = (ref: string) =>
  cmdAdd({ ref, version: undefined, yes: true, force: false, cwd: project.root })

it('aborts when the bytes served do not match the registry-advertised sha256', async () => {
  await setup({ mode: 'bad-hash' })
  await expect(add('@fixture/greeter')).rejects.toThrow(
    /does not match the registry's own file manifest/,
  )

  expect(await pathExists(join(project.skillsDir, 'greeter'))).toBe(false)
  expect(await pathExists(join(project.root, 'skillbarn.lock'))).toBe(false)
})

it('records nothing when clawhub reports success but installs nothing', async () => {
  await setup({ mode: 'empty' })
  await expect(add('@fixture/greeter')).rejects.toThrow(/installed nothing/)

  expect(await pathExists(join(project.root, 'skillbarn.lock'))).toBe(false)
  expect(await pathExists(join(project.skillsDir, 'greeter'))).toBe(false)
})

it('surfaces the owner list for an ambiguous slug rather than guessing', async () => {
  await setup()
  await expect(add('greeter')).rejects.toMatchObject({
    message: expect.stringContaining('more than one owner'),
    hint: expect.stringContaining('@fixture/greeter'),
  })
  expect(await pathExists(join(project.root, 'skillbarn.lock'))).toBe(false)
})

it('leaves nothing behind when the install itself fails', async () => {
  await setup({ mode: 'install-fails' })
  await expect(add('@fixture/greeter')).rejects.toThrow(/clawhub install failed/)
  expect(await pathExists(join(project.skillsDir, 'greeter'))).toBe(false)
  expect(await checkInvariants(project.root)).toEqual([])
})

describe('a crash between install and flatten', () => {
  it('never reaches the project, because the install happens in staging', async () => {
    await setup({ mode: 'partial-crash' })
    await expect(add('@fixture/greeter')).rejects.toThrow()

    expect(await pathExists(join(project.skillsDir, '@fixture'))).toBe(false)
    expect(await checkInvariants(project.root)).toEqual([])
  })

  it('is swept up if an older run left one in the tree', async () => {
    await setup()
    await add('@fixture/greeter')

    // What an in-place install would have left behind: a second copy that a loader
    // recursing for SKILL.md would pick up alongside the flattened one.
    await mkdir(join(project.skillsDir, '@fixture', 'greeter'), { recursive: true })
    await writeFile(
      join(project.skillsDir, '@fixture', 'greeter', 'SKILL.md'),
      '---\nname: greeter\n---\n',
    )

    expect(await cmdVerify({ cwd: project.root })).toBe(1)

    await cmdInstall({ force: false, cwd: project.root })
    expect(await pathExists(join(project.skillsDir, '@fixture'))).toBe(false)
    expect(await checkInvariants(project.root)).toEqual([])
  })
})

it('reports a vendored-looking directory that the lock does not know about', async () => {
  await setup()
  await mkdir(join(project.skillsDir, 'stowaway', '.clawhub'), { recursive: true })
  await writeFile(join(project.skillsDir, 'stowaway', '.clawhub', 'origin.json'), '{}')

  const violations = await checkInvariants(project.root)
  expect(violations).toContainEqual({
    invariant: 'lock-matches-disk',
    detail: 'stowaway looks vendored (has .clawhub/) but is not in the lock',
  })
})

it('reports a hand-edited managed gitignore', async () => {
  await setup()
  await add('@fixture/greeter')
  await writeFile(join(project.skillsDir, '.gitignore'), '# managed by skillbarn — do not edit\n')

  expect(await cmdVerify({ cwd: project.root })).toBe(1)
  await cmdInstall({ force: false, cwd: project.root })
  expect(await cmdVerify({ cwd: project.root })).toBe(0)
})
