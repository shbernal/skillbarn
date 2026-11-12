import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'skillbarn-'

/** Run `fn` with a staging workdir outside the project; always torn down. */
export async function withStaging<T>(fn: (staging: string) => Promise<T>): Promise<T> {
  const staging = await mkdtemp(join(tmpdir(), PREFIX))
  try {
    return await fn(staging)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
