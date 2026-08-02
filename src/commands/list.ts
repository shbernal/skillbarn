import { join } from 'node:path'
import { loadProject } from '../config.ts'
import { digestTree, isDirectory, pathExists, readDirNames } from '../fs-tree.ts'
import { lockedSlugs } from '../lock.ts'
import {
  entryDirName,
  entryPath,
  ignoredDirNames,
  readLockFile,
  requireIdentifiedProject,
} from '../project.ts'
import { out } from '../ui.ts'

export type ListOptions = {
  cwd: string
}

type Row = {
  name: string
  origin: string
  version: string
  status: string
}

export async function cmdList(options: ListOptions): Promise<number> {
  const project = await loadProject(options.cwd)
  await requireIdentifiedProject(project)
  const lock = await readLockFile(project)
  const rows: Row[] = []

  for (const slug of lockedSlugs(lock)) {
    const entry = lock.skills[slug]
    if (entry === undefined) continue
    const dir = entryPath(project, entry)
    const status = !(await isDirectory(dir))
      ? 'missing'
      : (await digestTree(dir)) === entry.integrity
        ? 'ok'
        : 'modified'
    rows.push({
      name: entryDirName(entry),
      origin: `@${entry.owner}`,
      version: entry.version,
      status,
    })
  }

  // Anything else in the tree is the user's own. The lock is the only definition of
  // vendored: flattening removed the `@` prefix that used to tell them apart.
  const managed = new Set(ignoredDirNames(lock))
  for (const name of await readDirNames(project.skillsDir)) {
    if (name.startsWith('@') || managed.has(name)) continue
    if (!(await pathExists(join(project.skillsDir, name, 'SKILL.md')))) continue
    rows.push({ name, origin: '—', version: '—', status: 'local' })
  }

  if (rows.length === 0) {
    out(`no skills in ${project.config.dir}`)
    return 0
  }

  const width = (pick: (row: Row) => string) => Math.max(...rows.map((row) => pick(row).length))
  const nameWidth = width((r) => r.name)
  const originWidth = width((r) => r.origin)
  const versionWidth = width((r) => r.version)

  for (const row of rows.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    out(
      `${row.name.padEnd(nameWidth)}  ${row.origin.padEnd(originWidth)}  ` +
        `${row.version.padEnd(versionWidth)}  ${row.status}`,
    )
  }
  return 0
}
