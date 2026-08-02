import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'skillbarn-'

/**
 * Staging directories this process currently owns. Exported so the invariant checker
 * can assert teardown happened, including on the failure paths.
 */
const active = new Set<string>()

export function activeStagingDirs(): string[] {
  return [...active].sort()
}

/** Run `fn` with a staging workdir outside the project; always torn down. */
export async function withStaging<T>(fn: (staging: string) => Promise<T>): Promise<T> {
  const staging = await mkdtemp(join(tmpdir(), PREFIX))
  active.add(staging)
  try {
    return await fn(staging)
  } finally {
    active.delete(staging)
    await rm(staging, { recursive: true, force: true })
  }
}
