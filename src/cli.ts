#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cmdAdd } from './commands/add.ts'
import { cmdInit } from './commands/init.ts'
import { cmdInstall } from './commands/install.ts'
import { cmdList } from './commands/list.ts'
import { cmdRemove } from './commands/remove.ts'
import { cmdVerify } from './commands/verify.ts'
import { isSkbError } from './errors.ts'
import { err, out } from './ui.ts'

const USAGE = `skb — vendor agent skills into a project, reproducibly

usage
  skb init [--dir <path>]
  skb add <@owner/slug> [--version <v>] [--yes] [--force]
  skb install [--force]                          (alias: i)
  skb remove <slug>                              (alias: rm)
  skb list
  skb verify

options
  --dir <path>    skills directory to configure (init only)
  --version <v>   version to add (add only); as a bare flag, prints skillbarn's version
  --yes, -y       skip the confirmation prompt
  --force         overwrite an existing local copy
  --help, -h      this text

The project is the nearest skillbarn.json, else the git root. That one file holds
both the configuration (dir, flatten, gitignore) and the declared skills. Skills land
in .agents/skills/<slug>/, gitignored from a committed skillbarn.lock.`

type Flags = {
  values: Map<string, string | boolean>
  positionals: string[]
}

/** Hand-rolled: the surface is five commands and four flags, and this ships with no deps. */
function parseArgs(argv: readonly string[], withValue: ReadonlySet<string>): Flags {
  const values = new Map<string, string | boolean>()
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    if (withValue.has(name)) {
      if (eq !== -1) {
        values.set(name, arg.slice(eq + 1))
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        throw new UsageError(`${name} needs a value`)
      }
      values.set(name, next)
      i++
      continue
    }
    if (eq !== -1) throw new UsageError(`${name} does not take a value`)
    values.set(name, true)
  }
  return { values, positionals }
}

class UsageError extends Error {}

async function version(): Promise<string> {
  const pkg = await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')
  return (JSON.parse(pkg) as { version: string }).version
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    out(USAGE)
    return command === undefined ? 2 : 0
  }
  if (command === '--version' || command === '-V') {
    out(await version())
    return 0
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    out(USAGE)
    return 0
  }

  const cwd = process.cwd()

  switch (command) {
    case 'init': {
      const { values, positionals } = parseArgs(rest, new Set(['--dir']))
      rejectUnknown(values, ['--dir'])
      if (positionals.length > 0) throw new UsageError('init takes no arguments, only --dir')
      const dir = values.get('--dir')
      return cmdInit({ dir: typeof dir === 'string' ? dir : undefined, cwd })
    }
    case 'add': {
      const { values, positionals } = parseArgs(rest, new Set(['--version']))
      rejectUnknown(values, ['--version', '--yes', '-y', '--force'])
      const ref = positionals[0]
      if (ref === undefined) throw new UsageError('add needs a skill, e.g. skb add @owner/slug')
      if (positionals.length > 1) throw new UsageError('add takes one skill at a time')
      const requested = values.get('--version')
      return cmdAdd({
        ref,
        version: typeof requested === 'string' ? requested : undefined,
        yes: values.has('--yes') || values.has('-y'),
        force: values.has('--force'),
        cwd,
      })
    }
    // `i` and `rm` are the two commands typed often enough to be worth an alias, and both
    // spellings are the ones the neighbouring package managers already train.
    case 'i':
    case 'install': {
      const { values, positionals } = parseArgs(rest, new Set())
      rejectUnknown(values, ['--force'])
      if (positionals.length > 0) {
        throw new UsageError('install takes no arguments — it restores the whole lock')
      }
      return cmdInstall({ force: values.has('--force'), cwd })
    }
    case 'rm':
    case 'remove': {
      const { values, positionals } = parseArgs(rest, new Set())
      rejectUnknown(values, [])
      const ref = positionals[0]
      if (ref === undefined) throw new UsageError('remove needs a skill slug')
      if (positionals.length > 1) throw new UsageError('remove takes one skill at a time')
      return cmdRemove({ ref, cwd })
    }
    case 'list': {
      const { values, positionals } = parseArgs(rest, new Set())
      rejectUnknown(values, [])
      if (positionals.length > 0) throw new UsageError('list takes no arguments')
      return cmdList({ cwd })
    }
    case 'verify': {
      const { values, positionals } = parseArgs(rest, new Set())
      rejectUnknown(values, [])
      if (positionals.length > 0) throw new UsageError('verify takes no arguments')
      return cmdVerify({ cwd })
    }
    default:
      throw new UsageError(`unknown command: ${command}`)
  }
}

function rejectUnknown(values: Flags['values'], allowed: readonly string[]): void {
  for (const name of values.keys()) {
    if (name === '--help' || name === '-h') continue
    if (!allowed.includes(name)) throw new UsageError(`unknown option: ${name}`)
  }
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof UsageError) {
    err(`skb: ${error.message}`)
    err('')
    err(USAGE)
    process.exitCode = 2
  } else if (isSkbError(error)) {
    err(`skb: ${error.message}`)
    if (error.hint !== undefined) err(error.hint)
    process.exitCode = 1
  } else {
    throw error
  }
}
