# skillbarn

Vendor agent skills into a project the way `node_modules` vendors packages: installed
from a committed lockfile, gitignored, reproducible in a fresh clone.

```console
$ skb add @shbernal/rfc-lookup
  @shbernal/rfc-lookup@0.1.0  RFC lookup
  license   MIT-0
  files     3 (40.7 KB)
  scans     clean, with warnings (vt=clean skillspector=clean llm=clean)
  severity  LOW

  Look up IETF RFCs and read what a specification actually says. Use
  whenever an RFC number comes up ("RFC 9110", "RFC 2616", "rfc7231"), when
  checking what a protocol spec requires, when quoting normative
  MUST/SHOULD/MAY language, when asked "what does the spec say about X", or
  when verifying whether an RFC is still current or has been obsoleted.
  Covers HTTP, TCP/IP, DNS, TLS, QUIC, SMTP, OAuth, JSON/JOSE and every
  other IETF standard. Finds the right RFC, reads one section instead of the
  whole document, and flags superseded specifications before they get cited.

  mentioned in the skill text (heuristic, not a sandbox report):
    tools     —
    commands  python3, rg
    env vars  RFC_MIRROR

  flagged by ClawHub's scanners:
    Credentials — note
      The helper uses HTTPS, reads RFC_MIRROR when set, caches RFC
      index/documents under a local mirror path, and can call rg/grep/rsync;
      these are disclosed and proportionate to RFC lookup and search.
    Persistence & Privilege — note
      Persistence is limited to RFC cache or mirror files and a sync stamp.
      The 512 MB rsync path is opt-in, prompts by default, and there is no
      background worker, credential access, or startup persistence.

  before installing: Before installing, be aware that normal use may
  download public RFC data and cache it locally. Only run the sync command
  if you want a large local mirror, and choose a dedicated mirror directory
  if overriding RFC_MIRROR or --mirror.

install @shbernal/rfc-lookup@0.1.0? [y/N] y
added @shbernal/rfc-lookup@0.1.0 -> .agents/skills/rfc-lookup
```

Commit `skillbarn.json` and `skillbarn.lock`; `.agents/skills/rfc-lookup/` is ignored. In a
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
| `skb install` | Restore exactly what the lock records. `--force` overwrites local edits. Alias `i`. |
| `skb update [<slug>]` | Show what a new version changes, ask, then move both records. `--version`, `--yes`. Alias `up`. |
| `skb outdated` | What the registry serves now, against the lock. Reads only; exits 1 if anything has moved. |
| `skb remove <slug>` | Delete the directory and both records. Never touches the registry. Alias `rm`. |
| `skb list` | Vendored skills with their state, plus any local ones. |
| `skb verify` | No network, CI-friendly. Fails if the project has drifted from the lock. |

## Updating

A new version is a new grant of trust, not a continuation of the old one — ClawHub
publishing is open, so it is a fresh decision about whoever holds that account. `skb update`
shows you what you would be agreeing to before it asks:

```console
$ skb update greeter
  @fixture/greeter  1.2.0 -> 1.3.0
  license   MIT
  files     3 (484 B)
  scans     clean (vt=clean llm=clean)

  newly mentioned in the skill text (heuristic, not a sandbox report):
    tools     Bash
    commands  —
    env vars  TELEMETRY_URL

  SKILL.md  +1 -0
  @@ -15,3 +15,4 @@
   ```bash
   jq -r .name person.json
   curl -s "$GREETER_ENDPOINT/hello"
  +curl -s "$TELEMETRY_URL/ping"

update @fixture/greeter 1.2.0 -> 1.3.0? [y/N]
```

With no slug it walks everything in the lock and asks once per skill. `--yes` skips the
prompts, `--version <v>` goes to a specific version — including backwards.

`skb outdated` answers the same question without changing anything, and its exit code is the
whole output contract, so it can run on a schedule:

```console
$ skb outdated
greeter     @fixture  1.2.0  1.3.0  outdated
pdf-filler  @fixture  0.4.1  =      current
```

Both also catch a **republished** version: the version string has not moved but the bytes
have. It is spotted from the hashes the registry advertises, so `outdated` sees it without
downloading anything.

There is no pinning to configure. The exact version lives in `skillbarn.json` and
`skillbarn.lock`, and nothing but `add`, `update` or `remove` ever moves it — `skb install`
restores what the lock says and never re-resolves.

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
    "@shbernal/rfc-lookup": { "source": "clawhub", "version": "0.1.0" }
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
- **An update is asked about, not applied.** The version delta, the registry's scan report
  and the `SKILL.md` diff are shown first, per skill, default-no.
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
