# skillbarn

Vendor agent skills into a project the way `node_modules` vendors packages: installed
from a committed lockfile, gitignored, reproducible in a fresh clone.

```console
$ skb add @seanford/humanizer
  @seanford/humanizer@1.0.0  Humanizer
  license   MIT-0
  files     4 (22.4 KB)
  scans     clean (vt=clean skillspector=suspicious llm=clean)

  Remove signs of AI-generated writing from text. Use when editing or reviewing
  text to make it sound more natural and human-written.

  mentioned in the skill text (heuristic, not a sandbox report):
    tools     Read, Write, Edit, Grep, Glob, AskUserQuestion
    commands  —
    env vars  —

install @seanford/humanizer@1.0.0? [y/N] y
added @seanford/humanizer@1.0.0 -> .agents/skills/humanizer
```

Commit `skillbarn.json` and `skillbarn.lock`; `.agents/skills/humanizer/` is ignored. In a
fresh clone, `skb install` puts back exactly those bytes or fails.

## Install

`skb` is a global CLI. It works out which project you are in from the working directory,
so one install covers every repo — including repos that have no `package.json` of their
own.

```sh
pnpm add -g skillbarn clawhub
```

npm is equally supported: `npm i -g skillbarn clawhub`. To run it without installing
anything, `pnpm dlx skillbarn verify` or `npx skillbarn verify` — worth knowing for CI,
where `verify` needs neither the network nor `clawhub`:

```yaml
- run: pnpm dlx skillbarn verify
```

Node 22 or newer. [`clawhub`](https://www.npmjs.com/package/clawhub) has to be on `PATH`
for `add` and `install`, and skillbarn deliberately does not bundle it: it drives that
CLI rather than reimplementing auth, search or publishing, and you upgrade it on its own
schedule. A missing `clawhub` is a runtime error naming the install command.

## Which project

The project root is the nearest directory with a `skillbarn.json`, and failing that the
git root. If neither exists, skillbarn refuses rather than treating the working directory
as a project — a global `skb add` mistyped in a home directory should not quietly create
one there. A `skillbarn.lock` counts on its own too, so an unpacked tarball with no `.git`
still installs.

`skb init` writes the manifest that settles it, and is also how you point skillbarn at the
directory your agent actually reads:

```sh
skb init --dir .claude/skills
```

You do not have to run it first. In a git repo with no manifest, `skb add` creates one —
but it shows you the settings it is about to write and folds that into the confirmation it
already asks, so nothing appears at your repo root unannounced.

## Commands

| Command | What it does |
|---|---|
| `skb init` | Write `skillbarn.json` here. `--dir <path>`. Never overwrites an existing one. |
| `skb add <@owner/slug>` | Show the skill, ask, install it, record it. `--version`, `--yes`, `--force`. |
| `skb install` | Restore exactly what the lock records. `--force` overwrites local edits. |
| `skb remove <slug>` | Delete the directory and both records. Never touches the registry. |
| `skb list` | Vendored skills with their state, plus any local ones. |
| `skb verify` | No network, CI-friendly. Fails if the project has drifted from the lock. |

## Configuration

`skillbarn.json` holds both halves, the way `package.json` does: how the project is
configured, and what it declares. Whichever command creates it writes the config out in
full, and every field is optional — delete the ones you have no opinion about.

```json
{
  "dir": ".agents/skills",
  "flatten": true,
  "gitignore": "managed",
  "skills": {
    "@seanford/humanizer": { "source": "clawhub", "version": "1.0.0" }
  }
}
```

`add` and `remove` rewrite the `skills` half and leave everything else — including keys
skillbarn does not recognize — exactly as you wrote it.

`gitignore: "off"` if you would rather commit the skills. skillbarn never symlinks into
`.claude/skills` or anywhere else — if you want that, make the symlink yourself; skillbarn
follows one it finds and writes into the real tree.

**Which `dir` your agent actually reads.** `.agents/skills` is a project skill root for
OpenClaw, but Claude Code (measured against 2.1.220) does not scan it — it reads
`.claude/skills` only. If Claude Code is your agent, either run
`skb init --dir .claude/skills` or symlink `.claude/skills` at `.agents/skills`;
skillbarn resolves the symlink and
writes into the real tree. Full table in [docs/loaders.md](docs/loaders.md).

## How it works

- **Skills are flattened** to `<dir>/<slug>/`. ClawHub installs to `<dir>/@owner/slug/`,
  which strict loaders cannot see. The owner survives as lockfile metadata.
- **Installs are staged outside the project**, then moved into place, so a failed
  download leaves nothing behind and ClawHub's own state never lands in the repo.
- **The lock carries an integrity digest**, cross-checked against the hashes the registry
  advertises. `skb install` refuses on a mismatch rather than warning.
- **The ignore list is derived from the lock**, not from a path heuristic, so
  hand-authored skills in the same directory stay tracked and untouched.
- **`skillbarn.json` is intent, `skillbarn.lock` is fact.** No semver resolution, no
  dependency graph — skills are leaf nodes.

The reasoning behind each of those, and the measurements they rest on, is in
[docs/design.md](docs/design.md).

## Documentation

| | |
|---|---|
| [docs/design.md](docs/design.md) | Why the tool is shaped this way |
| [docs/loaders.md](docs/loaders.md) | Where each agent looks for skills, measured |
| [docs/clawhub.md](docs/clawhub.md) | ClawHub CLI behaviour worth not re-deriving |
| [docs/testing.md](docs/testing.md) | The `PATH` seam, the layers, the shared oracle |
| [AGENTS.md](AGENTS.md) | Conventions for changing this repository |
