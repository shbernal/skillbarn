import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SkbError } from '../errors.ts'
import { pathExists } from '../fs-tree.ts'
import {
  MANIFEST_FILE,
  newManifest,
  parseManifest,
  renderManifest,
  resolveConfig,
} from '../manifest.ts'
import { findProjectRoot } from '../project.ts'
import { err, out } from '../ui.ts'

export type InitOptions = {
  dir: string | undefined
  cwd: string
}

/**
 * Write `skillbarn.json` here, which is what makes a directory a project.
 *
 * Always the cwd, never the discovered root: `init` is how you say where the project
 * starts, so inferring that would defeat the point.
 *
 * The file it writes is `newManifest()`, the same one `add` creates when it finds no
 * manifest — the defaults are written out in full either way, and which command created
 * the project does not show in the result.
 */
export async function cmdInit(options: InitOptions): Promise<number> {
  const root = resolve(options.cwd)
  const path = resolve(root, MANIFEST_FILE)

  if (await pathExists(path)) {
    throw new SkbError(
      `${MANIFEST_FILE} already exists in ${root}`,
      'edit it directly — `skb init` never overwrites a manifest',
    )
  }

  const manifest = newManifest()
  if (options.dir !== undefined) manifest.config.dir = options.dir
  const text = renderManifest(manifest)
  // Validated by the same parser that will read it back, so `--dir ../elsewhere` is
  // rejected here with the message it would have earned on the next command.
  const config = resolveConfig(parseManifest(text).config)

  const found = await findProjectRoot(root)
  if (found.origin === 'manifest' && found.root !== root) {
    err(`note: ${resolve(found.root, MANIFEST_FILE)} covered this directory until now`)
  }

  await writeFile(path, text, 'utf8')
  out(`created ${MANIFEST_FILE} — skills will be vendored into ${config.dir}`)
  return 0
}
