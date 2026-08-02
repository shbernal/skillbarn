import { execFile } from 'node:child_process'
import { SkbError } from './errors.ts'
import { type InspectResult, parseAmbiguousSlugError, parseInspectJson } from './inspect.ts'
import { formatSkillRef, isScoped, type SkillRef } from './slug.ts'

/**
 * The one place skillbarn shells out.
 *
 * Keep this module thin and free of policy: the whole test strategy is "put a fake
 * `clawhub` earlier on PATH and run the real code", which only stays honest as long as
 * nothing else in the codebase knows what a subprocess is.
 */
export type ClawhubRun = {
  code: number
  stdout: string
  stderr: string
}

export const CLAWHUB_BIN = 'clawhub'

/** The directory ClawHub installs into, inside the staging workdir. */
export const STAGING_SKILLS_DIR = 'pkgs'

export async function runClawhub(args: readonly string[]): Promise<ClawhubRun> {
  return new Promise((resolve, reject) => {
    execFile(
      CLAWHUB_BIN,
      [...args],
      { env: childEnv(), maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(missingClawhub())
          return
        }
        const code = err === null ? 0 : ((err as { code?: number }).code ?? 1)
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/**
 * `CLAWHUB_WORKDIR` / `CLAWDHUB_WORKDIR` silently redirect installs. Explicit
 * `--workdir` does win, and skillbarn always passes it — but a redirected install is
 * an unrecoverable mess, so the env is stripped as well.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CLAWHUB_WORKDIR
  delete env.CLAWDHUB_WORKDIR
  return env
}

function missingClawhub(): SkbError {
  return new SkbError(
    'clawhub is not on PATH',
    'skillbarn drives the clawhub CLI — install it first, e.g. `pnpm add -g clawhub`',
  )
}

/** Preflight. `--version` is an install/update/inspect option, not a global flag. */
export async function requireClawhub(): Promise<string> {
  const run = await runClawhub(['-V'])
  if (run.code !== 0) {
    throw new SkbError(
      `clawhub is on PATH but \`clawhub -V\` failed (exit ${run.code})`,
      run.stderr.trim() || undefined,
    )
  }
  return run.stdout.trim()
}

/**
 * One `inspect` call feeds both the confirmation gate and the integrity cross-check.
 * Never called twice for the same skill.
 */
export async function inspectSkill(ref: SkillRef, version?: string): Promise<InspectResult> {
  const args = ['inspect', formatSkillRef(ref), '--files', '--json']
  if (version !== undefined) args.push('--version', version)
  const run = await runClawhub(args)
  if (run.code !== 0) {
    const candidates = isScoped(ref) ? [] : parseAmbiguousSlugError(run.stderr + run.stdout)
    if (candidates.length > 1) {
      throw new SkbError(
        `"${ref.slug}" is published by more than one owner`,
        `pick one: ${candidates.join(', ')}`,
      )
    }
    throw new SkbError(
      `clawhub could not inspect ${formatSkillRef(ref)}`,
      run.stderr.trim() || run.stdout.trim() || undefined,
    )
  }
  return parseInspectJson(run.stdout)
}

export type StagedInstall = {
  ref: SkillRef & { owner: string }
  version: string
  staging: string
}

/**
 * Install into a staging workdir outside the project. ClawHub writes
 * `<workdir>/.clawhub/lock.json` unconditionally, so pointing `--workdir` at the
 * project root would drop a `.clawhub/` directory in the repo — state that is not
 * skillbarn's and that the managed `.gitignore` (which lives inside the skills dir)
 * could not cover anyway.
 */
export async function installIntoStaging(options: StagedInstall): Promise<void> {
  const args = [
    '--workdir',
    options.staging,
    '--dir',
    STAGING_SKILLS_DIR,
    'install',
    formatSkillRef(options.ref),
    '--version',
    options.version,
  ]
  const run = await runClawhub(args)
  if (run.code !== 0) {
    throw new SkbError(
      `clawhub install failed for ${formatSkillRef(options.ref)}@${options.version}`,
      run.stderr.trim() || run.stdout.trim() || undefined,
    )
  }
}
