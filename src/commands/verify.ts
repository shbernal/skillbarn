import { checkInvariants, formatViolations } from '../invariants.ts'
import { loadProject, requireIdentifiedProject } from '../project.ts'
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
  // Deliberately not inside `checkInvariants`: that function answers whether a project
  // is legal, and "there is no project here" is a question about the caller. In CI it
  // is the difference between a false green and a loud failure on a wrong directory.
  await requireIdentifiedProject(await loadProject(options.cwd))

  const violations = await checkInvariants(options.cwd)
  if (violations.length === 0) {
    out('ok')
    return 0
  }
  err('skillbarn: the project does not match its lock')
  err(formatViolations(violations))
  return 1
}
