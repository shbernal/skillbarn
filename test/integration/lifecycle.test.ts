import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cmdAdd } from '../../src/commands/add.ts'
import { cmdInit } from '../../src/commands/init.ts'
import { cmdInstall } from '../../src/commands/install.ts'
import { cmdList } from '../../src/commands/list.ts'
import { cmdRemove } from '../../src/commands/remove.ts'
import { cmdVerify } from '../../src/commands/verify.ts'
import { digestTree, pathExists } from '../../src/fs-tree.ts'
import { checkInvariants, formatViolations } from '../../src/invariants.ts'
import { type FixtureProject, makeFixtureProject, useEnv } from '../helpers/fixture-project.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.ts')
const run = promisify(execFile)

let project: FixtureProject
let restoreEnv: () => void

async function expectNoViolations(root: string): Promise<void> {
  const violations = await checkInvariants(root)
  expect(formatViolations(violations)).toBe('')
}

/** The confirmation gate and everything it prints go to stderr, so that is what is read. */
async function captureStderr(run: () => Promise<unknown>): Promise<string> {
  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write
  try {
    await run()
  } finally {
    process.stderr.write = original
  }
  return written.join('')
}

async function setup(options: Parameters<typeof makeFixtureProject>[0] = {}): Promise<void> {
  project = await makeFixtureProject({ localSkills: ['my-local'], ...options })
  restoreEnv = useEnv(project.env)
}

afterEach(async () => {
  restoreEnv?.()
  await project?.dispose()
})

describe('add', () => {
  beforeEach(() => setup())

  it('flattens the install and records it', async () => {
    expect(
      await cmdAdd({
        ref: '@fixture/greeter',
        version: undefined,
        yes: true,
        force: false,
        cwd: project.root,
      }),
    ).toBe(0)

    expect(await pathExists(join(project.skillsDir, 'greeter', 'SKILL.md'))).toBe(true)
    expect(await pathExists(join(project.skillsDir, '@fixture'))).toBe(false)
    // ClawHub's provenance file survives the move, and is excluded from the digest.
    expect(await pathExists(join(project.skillsDir, 'greeter', '.clawhub', 'origin.json'))).toBe(
      true,
    )

    // The project was a bare git checkout, so this run created the manifest — and a
    // manifest skillbarn creates states the settings it is about to run under.
    expect(JSON.parse(await project.read('skillbarn.json'))).toEqual({
      dir: '.agents/skills',
      flatten: true,
      gitignore: 'managed',
      skills: { '@fixture/greeter': { source: 'clawhub', version: '1.2.0' } },
    })
    const lock = JSON.parse(await project.read('skillbarn.lock'))
    expect(lock.skills.greeter).toMatchObject({
      source: 'clawhub',
      owner: 'fixture',
      slug: 'greeter',
      version: '1.2.0',
      path: '.agents/skills/greeter',
    })
    expect(lock.skills.greeter.integrity).toMatch(/^sha256-[0-9a-f]{64}$/)

    expect(await project.read('.agents/skills/.gitignore')).toBe(
      '# managed by skillbarn — do not edit\n/greeter/\n',
    )
    await expectNoViolations(project.root)
  })

  it('says it is creating the project, and only says it the once', async () => {
    const first = await captureStderr(() =>
      cmdAdd({
        ref: '@fixture/greeter',
        version: undefined,
        yes: true,
        force: false,
        cwd: project.root,
      }),
    )
    expect(first).toContain('no skillbarn project here yet')
    expect(first).toContain('dir        .agents/skills')

    const second = await captureStderr(() =>
      cmdAdd({
        ref: '@fixture/pdf-filler',
        version: undefined,
        yes: true,
        force: false,
        cwd: project.root,
      }),
    )
    expect(second).not.toContain('no skillbarn project here yet')
  })

  it('leaves a hand-authored skill in the same directory untouched', async () => {
    const before = await readFile(join(project.skillsDir, 'my-local', 'SKILL.md'), 'utf8')
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    expect(await readFile(join(project.skillsDir, 'my-local', 'SKILL.md'), 'utf8')).toBe(before)
    expect(await project.read('.agents/skills/.gitignore')).not.toContain('my-local')
  })

  it('never lets ClawHub write outside the skills directory', async () => {
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    expect(await pathExists(join(project.root, '.clawhub'))).toBe(false)

    const [, install] = await project.calls()
    const workdir = install?.[install.indexOf('--workdir') + 1]
    expect(workdir).toBeDefined()
    expect(workdir?.startsWith(project.root)).toBe(false)
  })

  it('refuses a second skill with a slug that is already vendored', async () => {
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    await expect(
      cmdAdd({
        ref: '@other/greeter',
        version: undefined,
        yes: true,
        force: false,
        cwd: project.root,
      }),
    ).rejects.toThrow(/already vendored from @fixture/)
    // The rejected skill left nothing behind.
    expect(JSON.parse(await project.read('skillbarn.lock')).skills.greeter.owner).toBe('fixture')
    await expectNoViolations(project.root)
  })

  it('will not overwrite a directory it does not own', async () => {
    await mkdir(join(project.skillsDir, 'greeter'), { recursive: true })
    await writeFile(join(project.skillsDir, 'greeter', 'SKILL.md'), 'mine\n')
    await expect(
      cmdAdd({
        ref: '@fixture/greeter',
        version: undefined,
        yes: true,
        force: false,
        cwd: project.root,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('already exists'),
      hint: expect.stringContaining('move it aside'),
    })
    expect(await readFile(join(project.skillsDir, 'greeter', 'SKILL.md'), 'utf8')).toBe('mine\n')
  })
})

describe('install', () => {
  beforeEach(() => setup())

  it('restores a wiped skill and leaves the local one alone', async () => {
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    const before = await digestTree(join(project.skillsDir, 'greeter'))

    await rm(join(project.skillsDir, 'greeter'), { recursive: true })
    expect(await cmdInstall({ force: false, cwd: project.root })).toBe(0)

    expect(await digestTree(join(project.skillsDir, 'greeter'))).toBe(before)
    expect(await pathExists(join(project.skillsDir, 'my-local', 'SKILL.md'))).toBe(true)
    await expectNoViolations(project.root)
  })

  it('is idempotent', async () => {
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    const lock = await project.read('skillbarn.lock')
    const ignore = await project.read('.agents/skills/.gitignore')

    await cmdInstall({ force: false, cwd: project.root })
    await cmdInstall({ force: false, cwd: project.root })

    expect(await project.read('skillbarn.lock')).toBe(lock)
    expect(await project.read('.agents/skills/.gitignore')).toBe(ignore)
    await expectNoViolations(project.root)
  })

  it('pins the locked version and never asks ClawHub to update', async () => {
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    await rm(join(project.skillsDir, 'greeter'), { recursive: true })
    await cmdInstall({ force: false, cwd: project.root })

    const calls = await project.calls()
    expect(calls.some((call) => call.includes('update'))).toBe(false)
    const restore = calls.at(-1) as string[]
    expect(restore).toContain('install')
    expect(restore[restore.indexOf('--version') + 1]).toBe('1.2.0')
  })

  it('refuses to run over a locally modified skill, and repairs it with --force', async () => {
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    const skillMd = join(project.skillsDir, 'greeter', 'SKILL.md')
    await writeFile(skillMd, `${await readFile(skillMd, 'utf8')}\ntampered\n`)

    expect(await cmdVerify({ cwd: project.root })).toBe(1)
    await expect(cmdInstall({ force: false, cwd: project.root })).rejects.toThrow(
      /does not match the lock/,
    )

    expect(await cmdInstall({ force: true, cwd: project.root })).toBe(0)
    expect(await cmdVerify({ cwd: project.root })).toBe(0)
  })

  it('does nothing but regenerate the gitignore when the lock is empty', async () => {
    expect(await cmdInstall({ force: false, cwd: project.root })).toBe(0)
    expect(await project.read('.agents/skills/.gitignore')).toBe(
      '# managed by skillbarn — do not edit\n',
    )
    expect(await project.calls()).toEqual([])
  })
})

describe('remove and list', () => {
  beforeEach(() => setup())

  it('deletes the tree and both records, without calling clawhub', async () => {
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    const callsBefore = (await project.calls()).length

    expect(await cmdRemove({ ref: 'greeter', cwd: project.root })).toBe(0)

    expect(await pathExists(join(project.skillsDir, 'greeter'))).toBe(false)
    expect(JSON.parse(await project.read('skillbarn.json')).skills).toEqual({})
    expect(JSON.parse(await project.read('skillbarn.lock')).skills).toEqual({})
    expect(await project.read('.agents/skills/.gitignore')).toBe(
      '# managed by skillbarn — do not edit\n',
    )
    expect((await project.calls()).length).toBe(callsBefore)
    expect(await pathExists(join(project.skillsDir, 'my-local'))).toBe(true)
    await expectNoViolations(project.root)
  })

  it('separates vendored from local', async () => {
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    const lines: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await cmdList({ cwd: project.root })
    } finally {
      process.stdout.write = write
    }
    const output = lines.join('')
    expect(output).toMatch(/greeter\s+@fixture\s+1\.2\.0\s+ok/)
    expect(output).toMatch(/my-local\s+—\s+—\s+local/)
  })
})

describe('configuration', () => {
  it('honours a custom skills directory', async () => {
    await setup({ config: { dir: 'vendor/skills' } })
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })

    expect(await pathExists(join(project.root, 'vendor', 'skills', 'greeter', 'SKILL.md'))).toBe(
      true,
    )
    expect(JSON.parse(await project.read('skillbarn.lock')).skills.greeter.path).toBe(
      'vendor/skills/greeter',
    )
    expect(await project.read('vendor/skills/.gitignore')).toContain('/greeter/')
    await expectNoViolations(project.root)
  })

  it('writes no gitignore when it is turned off', async () => {
    await setup({ config: { gitignore: 'off' } })
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    expect(await pathExists(join(project.skillsDir, '.gitignore'))).toBe(false)
    await expectNoViolations(project.root)
  })

  it('keeps @owner/ nesting when flattening is turned off', async () => {
    await setup({ config: { flatten: false } })
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })

    expect(await pathExists(join(project.skillsDir, '@fixture', 'greeter', 'SKILL.md'))).toBe(true)
    expect(await project.read('.agents/skills/.gitignore')).toContain('/@fixture/greeter/')
    // The sweep must not eat a directory the lock claims.
    await cmdInstall({ force: false, cwd: project.root })
    expect(await pathExists(join(project.skillsDir, '@fixture', 'greeter', 'SKILL.md'))).toBe(true)
    await expectNoViolations(project.root)
  })

  it('rewrites the skills half without disturbing the rest of the manifest', async () => {
    await setup({ config: { $schema: './skillbarn.schema.json', dir: 'vendor/skills' } })
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })

    // Config half intact, unknown key intact, and no default written in behind the
    // project's back — `flatten` and `gitignore` were never set and must stay unset.
    expect(JSON.parse(await project.read('skillbarn.json'))).toEqual({
      $schema: './skillbarn.schema.json',
      dir: 'vendor/skills',
      skills: { '@fixture/greeter': { source: 'clawhub', version: '1.2.0' } },
    })

    await cmdRemove({ ref: 'greeter', cwd: project.root })
    expect(JSON.parse(await project.read('skillbarn.json'))).toEqual({
      $schema: './skillbarn.schema.json',
      dir: 'vendor/skills',
      skills: {},
    })
  })

  it('follows a symlinked skills directory to the tree it points at', async () => {
    await setup()
    const real = join(project.root, '.claude', 'skills')
    await mkdir(real, { recursive: true })
    await rm(project.skillsDir, { recursive: true })
    await symlink(real, project.skillsDir, 'dir')

    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    expect(await pathExists(join(real, 'greeter', 'SKILL.md'))).toBe(true)
    expect(await pathExists(join(real, '.gitignore'))).toBe(true)
    await expectNoViolations(project.root)
  })
})

describe('init', () => {
  it('makes a directory a project that nothing else identified', async () => {
    await setup({ git: false })

    expect(await cmdInit({ dir: undefined, cwd: project.root })).toBe(0)
    expect(JSON.parse(await project.read('skillbarn.json'))).toEqual({
      dir: '.agents/skills',
      flatten: true,
      gitignore: 'managed',
      skills: {},
    })

    expect(
      await cmdAdd({
        ref: '@fixture/greeter',
        version: undefined,
        yes: true,
        force: false,
        cwd: project.root,
      }),
    ).toBe(0)
    await expectNoViolations(project.root)
  })

  it('honours --dir, and vendors there', async () => {
    await setup({ git: false })
    await cmdInit({ dir: '.claude/skills', cwd: project.root })

    expect(JSON.parse(await project.read('skillbarn.json')).dir).toBe('.claude/skills')
    await cmdAdd({
      ref: '@fixture/greeter',
      version: undefined,
      yes: true,
      force: false,
      cwd: project.root,
    })
    expect(await pathExists(join(project.root, '.claude', 'skills', 'greeter', 'SKILL.md'))).toBe(
      true,
    )
  })

  it('rejects a --dir that escapes the project, before writing anything', async () => {
    await setup({ git: false })
    await expect(cmdInit({ dir: '../elsewhere', cwd: project.root })).rejects.toThrow(
      /must be a relative path inside the project/,
    )
    expect(await pathExists(join(project.root, 'skillbarn.json'))).toBe(false)
  })

  it('never overwrites an existing config', async () => {
    await setup({ config: { dir: 'skills' } })
    await expect(cmdInit({ dir: undefined, cwd: project.root })).rejects.toThrow(/already exists/)
    expect(JSON.parse(await project.read('skillbarn.json'))).toEqual({ dir: 'skills' })
  })
})

describe('the cli itself', () => {
  beforeEach(() => setup())

  it('runs end to end as a subprocess', async () => {
    const env = { ...process.env, ...project.env }
    await run('node', [CLI, 'add', '@fixture/greeter', '--yes'], { cwd: project.root, env })
    const { stdout } = await run('node', [CLI, 'verify'], { cwd: project.root, env })
    expect(stdout.trim()).toBe('ok')
  })

  it('exits 2 on a usage error and 1 on a user error', async () => {
    const env = { ...process.env, ...project.env }
    await expect(run('node', [CLI, 'nonsense'], { cwd: project.root, env })).rejects.toMatchObject({
      code: 2,
    })
    await expect(
      run('node', [CLI, 'remove', 'absent'], { cwd: project.root, env }),
    ).rejects.toMatchObject({ code: 1 })
    await expect(run('node', [CLI, 'add'], { cwd: project.root, env })).rejects.toMatchObject({
      code: 2,
    })
  })

  it('refuses to install without a confirmation it cannot ask for', async () => {
    const env = { ...process.env, ...project.env }
    await expect(
      run('node', [CLI, 'add', '@fixture/greeter'], { cwd: project.root, env }),
    ).rejects.toMatchObject({ code: 1 })
    expect(await pathExists(join(project.root, 'skillbarn.lock'))).toBe(false)
  })
})
