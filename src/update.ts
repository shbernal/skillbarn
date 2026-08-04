import { excludeFromDigest, treeDigest } from './digest.ts'
import type { InspectResult } from './inspect.ts'
import type { LockEntry } from './lock.ts'

/**
 * What the registry currently serves, against what the lock records.
 *
 * `republished` is the case worth having a name for: the version string did not move but
 * the bytes behind it did. ClawHub publishing is open, so that is a thing an account can
 * do, and it is invisible to anything that compares version strings. It is the same
 * event `skb install` refuses on from the other direction, where the *locked* bytes no
 * longer match what is served.
 */
export type UpdateStatus = 'current' | 'outdated' | 'republished'

export type Resolution = {
  entry: LockEntry
  status: UpdateStatus
  /** The version the registry resolved to — latest, or whatever `--version` asked for. */
  version: string
  /** The integrity that version's bytes will produce once installed. */
  integrity: string
}

/**
 * The integrity a version will have once installed, from the registry's file manifest
 * rather than from a download.
 *
 * These are the same number by construction, not by coincidence: `vendorSkill()` cross
 * checks the installed tree against this exact manifest through `compareFileHashes` and
 * refuses on any difference, so an install that succeeds has hashed the same paths and
 * the same digests this did. That is what lets `skb outdated` notice a republished
 * version over the network without fetching a byte of it.
 */
export function manifestIntegrity(inspected: InspectResult): string {
  return treeDigest(excludeFromDigest(inspected.files))
}

export function classify(entry: LockEntry, inspected: InspectResult): Resolution {
  const integrity = manifestIntegrity(inspected)
  const status: UpdateStatus =
    inspected.version !== entry.version
      ? 'outdated'
      : integrity === entry.integrity
        ? 'current'
        : 'republished'
  return { entry, status, version: inspected.version, integrity }
}
