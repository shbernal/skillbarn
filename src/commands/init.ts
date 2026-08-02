import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  findProjectRoot,
  parseConfig,
  renderConfig,
} from '../config.ts'
import { SkbError } from '../errors.ts'
import { pathExists } from '../fs-tree.ts'
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
 */
export async function cmdInit(options: InitOptions): Promise<number> {
  const root = resolve(options.cwd)
  const path = resolve(root, CONFIG_FILE)

  if (await pathExists(path)) {
    throw new SkbError(
      `${CONFIG_FILE} already exists in ${root}`,
      'edit it directly — `skb init` never overwrites a config',
    )
  }

  const text = renderConfig({
    ...DEFAULT_CONFIG,
    ...(options.dir === undefined ? {} : { dir: options.dir }),
  })
  // Validated by the same parser that will read it back, so `--dir ../elsewhere` is
  // rejected here with the message it would have earned on the next command.
  const config = parseConfig(text)

  const found = await findProjectRoot(root)
  if (found.origin === 'config' && found.root !== root) {
    err(`note: ${resolve(found.root, CONFIG_FILE)} covered this directory until now`)
  }

  await writeFile(path, text, 'utf8')
  out(`created ${CONFIG_FILE} — skills will be vendored into ${config.dir}`)
  return 0
}
