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

Commit `skills.json` and `skillbarn.lock`; `.agents/skills/humanizer/` is ignored. In a
fresh clone, `skb install` puts back exactly those bytes or fails.

## Requirements

Node 22 or newer, and the [`clawhub`](https://www.npmjs.com/package/clawhub) CLI on
`PATH`. skillbarn drives that CLI rather than reimplementing auth, search or publishing.

## Commands

| Command | What it does |
|---|---|
| `skb add <@owner/slug>` | Show the skill, ask, install it, record it. `--version`, `--yes`, `--force`. |
| `skb install` | Restore exactly what the lock records. `--force` overwrites local edits. |
| `skb remove <slug>` | Delete the directory and both records. Never touches the registry. |
| `skb list` | Vendored skills with their state, plus any local ones. |
| `skb verify` | No network, CI-friendly. Fails if the project has drifted from the lock. |

## Configuration

`skillbarn.json` at the project root, all fields optional:

```json
{
  "dir": ".agents/skills",
  "flatten": true,
  "gitignore": "managed"
}
```

`gitignore: "off"` if you would rather commit the skills. skillbarn never symlinks into
`.claude/skills` or anywhere else — if you want that, make the symlink yourself.

**Which `dir` your agent actually reads.** `.agents/skills` is a project skill root for
OpenClaw, but Claude Code (measured against 2.1.220) does not scan it — it reads
`.claude/skills` only. If Claude Code is your agent, either set `"dir": ".claude/skills"`
or symlink `.claude/skills` at `.agents/skills`; skillbarn resolves the symlink and
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
- **`skills.json` is intent, `skillbarn.lock` is fact.** No semver resolution, no
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
