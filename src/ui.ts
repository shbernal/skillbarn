import { createInterface } from 'node:readline/promises'
import { SkbError } from './errors.ts'

export function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

export function err(line = ''): void {
  process.stderr.write(`${line}\n`)
}

/**
 * Ask before installing. Deliberately the inverse of `npm install`'s trust-by-default:
 * the payload is instructions an agent will execute, and gitignoring it means nobody
 * reads it again.
 */
export async function confirm(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true
  if (process.stdin.isTTY !== true) {
    throw new SkbError(
      'refusing to install without confirmation',
      'no terminal to prompt on — pass --yes if this is deliberate',
    )
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}
