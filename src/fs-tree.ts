import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readdir, readlink, rename, rm, rmdir, stat } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { excludeFromDigest, type FileHash, treeDigest } from './digest.ts'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Every file under `dir`, as POSIX paths relative to it, sorted. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  await walk(dir, dir, out)
  return out.sort()
}

async function walk(root: string, current: string, out: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(current, entry.name)
    if (entry.isDirectory()) await walk(root, full, out)
    else out.push(relative(root, full).split(sep).join(posix.sep))
  }
}

/**
 * Hash every file in a skill tree. Symlinks are hashed as their target string rather
 * than followed: a vendored tree should not be able to make the digest depend on
 * something outside itself.
 */
export async function hashTree(dir: string): Promise<FileHash[]> {
  const paths = await listFiles(dir)
  const files: FileHash[] = []
  for (const path of paths) {
    files.push({ path, sha256: await hashFile(join(dir, ...path.split(posix.sep))) })
  }
  return files
}

export async function hashFile(path: string): Promise<string> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    return createHash('sha256')
      .update(`symlink:${await readlink(path)}`)
      .digest('hex')
  }
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** The integrity value recorded in the lock, over the tree as installed on disk. */
export async function digestTree(dir: string): Promise<string> {
  return treeDigest(excludeFromDigest(await hashTree(dir)))
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/**
 * Move a directory into place. `rename` is atomic within a filesystem; staging lives
 * in the OS temp dir, which is frequently a different one, hence the copy fallback.
 */
export async function movePath(from: string, to: string): Promise<void> {
  await mkdir(join(to, '..'), { recursive: true })
  try {
    await rename(from, to)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }
  await cp(from, to, { recursive: true, verbatimSymlinks: true })
  await rm(from, { recursive: true, force: true })
}

/** Remove a directory only if nothing is left in it. */
export async function removeIfEmpty(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  } catch {
    // Missing or non-empty: nothing to do either way.
  }
}

/** Directory entries of `dir`, or `[]` if it does not exist. */
export async function readDirNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}
