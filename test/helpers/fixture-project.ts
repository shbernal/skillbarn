import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const FAKE_CLAWHUB = join(HERE, 'fake-clawhub.mjs')
export const FIXTURE_REGISTRY = join(HERE, '..', 'fixtures', 'registry')

export type FakeMode = 'ok' | 'empty' | 'partial-crash' | 'bad-hash' | 'install-fails'

export type FixtureProject = {
  root: string
  skillsDir: string
  /** Environment a child process (or this one) needs to reach the fake clawhub. */
  env: Record<string, string>
  /** One JSON line per fake-clawhub invocation. */
  calls: () => Promise<string[][]>
  read: (relativePath: string) => Promise<string>
  dispose: () => Promise<void>
}

export type FixtureOptions = {
  mode?: FakeMode
  /** Written to `skillbarn.json`. Omitted entirely when absent. */
  config?: Record<string, unknown>
  /** Hand-authored skills that must survive every command. */
  localSkills?: string[]
}

/**
 * A throwaway project with a fake `clawhub` first on PATH. Nothing is mocked: the real
 * commands run against real directories and a real subprocess.
 */
export async function makeFixtureProject(options: FixtureOptions = {}): Promise<FixtureProject> {
  const root = await mkdtemp(join(tmpdir(), 'skillbarn-test-'))
  const binDir = join(root, '.bin')
  const logFile = join(root, '.clawhub-calls.log')
  const dir = typeof options.config?.dir === 'string' ? options.config.dir : '.agents/skills'
  const skillsDir = join(root, ...dir.split('/'))

  await mkdir(binDir, { recursive: true })
  await writeFile(join(binDir, 'clawhub'), `#!/bin/sh\nexec node ${FAKE_CLAWHUB} "$@"\n`, 'utf8')
  await chmod(join(binDir, 'clawhub'), 0o755)
  await writeFile(logFile, '', 'utf8')

  await mkdir(skillsDir, { recursive: true })
  for (const name of options.localSkills ?? []) {
    await mkdir(join(skillsDir, name), { recursive: true })
    await writeFile(
      join(skillsDir, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: hand-authored, not vendored\n---\n\nlocal\n`,
      'utf8',
    )
  }
  if (options.config !== undefined) {
    await writeFile(join(root, 'skillbarn.json'), `${JSON.stringify(options.config, null, 2)}\n`)
  }

  const env: Record<string, string> = {
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    FAKE_CLAWHUB_FIXTURES: FIXTURE_REGISTRY,
    FAKE_CLAWHUB_MODE: options.mode ?? 'ok',
    FAKE_CLAWHUB_LOG: logFile,
  }

  return {
    root,
    skillsDir,
    env,
    calls: async () => {
      const text = await readFile(logFile, 'utf8')
      return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as string[])
    },
    read: (relativePath: string) => readFile(join(root, ...relativePath.split('/')), 'utf8'),
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

/** Apply a fixture's environment for the duration of a test, then put it back. */
export function useEnv(env: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
