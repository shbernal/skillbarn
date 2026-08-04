import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cmdAdd } from '../../src/commands/add.ts'
import { cmdInstall } from '../../src/commands/install.ts'
import { cmdList } from '../../src/commands/list.ts'
import { cmdUpdate } from '../../src/commands/update.ts'
import { cmdVerify } from '../../src/commands/verify.ts'
import { isDigestExcluded, treeDigest } from '../../src/digest.ts'
import { digestTree, hashTree, pathExists } from '../../src/fs-tree.ts'
import { checkInvariants } from '../../src/invariants.ts'
import {
  type FakeMode,
  type FixtureProject,
  makeFixtureProject,
  type Publication,
  useEnv,
} from '../helpers/fixture-project.ts'

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

describe("clawhub's own bookkeeping", () => {
  it('is stripped in staging, so it never reaches the project', async () => {
    await setup()
    await add('@fixture/greeter')

    const skill = join(project.skillsDir, 'greeter')
    expect(await pathExists(join(skill, '.clawhub'))).toBe(false)
    expect(await pathExists(join(skill, '_meta.json'))).toBe(false)

    // The strip is what makes this true: every remaining file is one the digest hashed,
    // so nothing in the tree is outside the integrity the lock records.
    const files = await hashTree(skill)
    expect(files.filter((f) => isDigestExcluded(f.path))).toEqual([])
    expect(treeDigest(files)).toBe(
      JSON.parse(await project.read('skillbarn.lock')).skills.greeter.integrity,
    )
  })

  it('cannot smuggle a second skill in past the digest exclusion', async () => {
    await setup({ mode: 'bookkeeping-stowaway' })
    await add('@fixture/greeter')

    // `.clawhub/` is excluded from the digest, so a SKILL.md hidden there would be
    // neither hashed nor locked — and OpenClaw, which finds SKILL.md anywhere under a
    // root, would load it. Stripping the directory is what closes that off.
    expect(await pathExists(join(project.skillsDir, 'greeter', '.clawhub'))).toBe(false)
    expect(await checkInvariants(project.root)).toEqual([])
  })

  it('marks a directory that clawhub installed here directly', async () => {
    await setup()
    await mkdir(join(project.skillsDir, 'stowaway', '.clawhub'), { recursive: true })
    await writeFile(join(project.skillsDir, 'stowaway', '.clawhub', 'origin.json'), '{}')

    const violations = await checkInvariants(project.root)
    expect(violations).toContainEqual({
      invariant: 'lock-matches-disk',
      detail: 'stowaway was installed by clawhub directly, not by skillbarn',
    })
  })
})

describe('a directory that nothing identifies as a project', () => {
  it('is refused rather than turned into one, and nothing is written', async () => {
    await setup({ git: false })

    await expect(add('@fixture/greeter')).rejects.toMatchObject({
      message: expect.stringContaining('no project here'),
      hint: expect.stringContaining('skb init'),
    })

    expect(await pathExists(join(project.root, 'skillbarn.json'))).toBe(false)
    expect(await pathExists(join(project.root, 'skillbarn.lock'))).toBe(false)
    expect(await pathExists(join(project.skillsDir, 'greeter'))).toBe(false)
  })

  it('refuses the read-only commands too, so a wrong cwd in CI is loud', async () => {
    await setup({ git: false })
    await expect(cmdVerify({ cwd: project.root })).rejects.toThrow(/no project here/)
    await expect(cmdList({ cwd: project.root })).rejects.toThrow(/no project here/)
    await expect(cmdInstall({ force: false, cwd: project.root })).rejects.toThrow(/no project here/)
  })

  it('does not include one already carrying a lock — an unpacked tarball has no .git', async () => {
    await setup()
    await add('@fixture/greeter')
    await rm(join(project.root, '.git'), { recursive: true })

    expect(await cmdInstall({ force: false, cwd: project.root })).toBe(0)
    expect(await cmdVerify({ cwd: project.root })).toBe(0)
  })
})

/**
 * Accepting a new version is a second grant of execution trust, so a failure part-way
 * through one has to leave the project describable in a sentence. For a single skill
 * that sentence is "exactly as it was found". For several it is weaker and deliberately
 * so: every skill is written through completely before the next is looked at, so what
 * survives a failure is a project that still matches its own lock.
 */
describe('an update that fails part-way', () => {
  const publish = (published: Record<string, Publication>, mode?: FakeMode) => {
    restoreEnv?.()
    restoreEnv = useEnv({
      ...project.env,
      ...(mode === undefined ? {} : { FAKE_CLAWHUB_MODE: mode }),
      FAKE_CLAWHUB_PUBLISHED: JSON.stringify(published),
    })
  }
  const update = () =>
    cmdUpdate({ ref: undefined, version: undefined, yes: true, cwd: project.root })

  it('leaves the version it could not verify exactly where it was', async () => {
    await setup()
    await add('@fixture/greeter')
    const before = await digestTree(join(project.skillsDir, 'greeter'))

    publish({ '@fixture/greeter': { version: '1.3.0' } }, 'bad-hash')
    await expect(update()).rejects.toThrow(/does not match the registry's own file manifest/)

    expect(await digestTree(join(project.skillsDir, 'greeter'))).toBe(before)
    expect(JSON.parse(await project.read('skillbarn.lock')).skills.greeter.version).toBe('1.2.0')
    expect(await checkInvariants(project.root)).toEqual([])
  })

  it('leaves nothing behind when the download itself fails', async () => {
    await setup()
    await add('@fixture/greeter')

    publish({ '@fixture/greeter': { version: '1.3.0' } }, 'install-fails')
    await expect(update()).rejects.toThrow(/clawhub install failed/)

    expect(JSON.parse(await project.read('skillbarn.lock')).skills.greeter.version).toBe('1.2.0')
    expect(await checkInvariants(project.root)).toEqual([])
  })

  it('keeps the skills it already finished, and the lock agrees with all of them', async () => {
    await setup()
    await add('@fixture/greeter')
    await add('@fixture/pdf-filler')
    const untouched = await digestTree(join(project.skillsDir, 'pdf-filler'))

    publish({
      '@fixture/greeter': { version: '1.3.0' },
      '@fixture/pdf-filler': { version: '0.5.0', fails: true },
    })
    await expect(update()).rejects.toThrow(/clawhub install failed/)

    const lock = JSON.parse(await project.read('skillbarn.lock'))
    expect(lock.skills.greeter.version).toBe('1.3.0')
    expect(lock.skills['pdf-filler'].version).toBe('0.4.1')
    expect(await digestTree(join(project.skillsDir, 'pdf-filler'))).toBe(untouched)

    // The manifest moved with it, so a fresh clone reproduces what is actually here.
    expect(JSON.parse(await project.read('skillbarn.json')).skills).toEqual({
      '@fixture/greeter': { source: 'clawhub', version: '1.3.0' },
      '@fixture/pdf-filler': { source: 'clawhub', version: '0.4.1' },
    })
    expect(await cmdVerify({ cwd: project.root })).toBe(0)
    expect(await checkInvariants(project.root)).toEqual([])
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
