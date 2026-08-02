import { checkInvariants, formatViolations } from '../invariants.ts'
import { err, out } from '../ui.ts'

export type VerifyOptions = {
  cwd: string
}

/**
 * No network, safe in CI. This runs the same invariant checker the tests use, rather
 * than a verify-only reimplementation of it — the digest comparison is only one of the
 * six things that have to hold, and the others fail just as loudly.
 */
export async function cmdVerify(options: VerifyOptions): Promise<number> {
  const violations = await checkInvariants(options.cwd)
  if (violations.length === 0) {
    out('ok')
    return 0
  }
  err('skillbarn: the project does not match its lock')
  err(formatViolations(violations))
  return 1
}
