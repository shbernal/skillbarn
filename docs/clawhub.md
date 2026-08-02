# ClawHub CLI notes

Everything here was verified empirically against `clawhub` v0.23.1 (2026-08-02). It is
recorded because rediscovering it costs network calls and confusion, and because several
items are traps that skillbarn works around rather than features it uses.

## Invocation

- Global flags: `--workdir <dir>` (default cwd) and `--dir <dir>` — the skills directory,
  **relative to the workdir**, default `skills`.
- `-V` / `--cli-version` prints the version. `--version` is *not* a global flag (it is an
  option of `install` / `update` / `inspect`), so a preflight must not probe with
  `clawhub --version`.
- The removal subcommand is **`uninstall`**, not `remove`. skillbarn never calls it: removal
  is a local operation on a vendored tree, and asking the registry client to do it would
  reintroduce the workdir problem for no gain.
- `install` flags: `--version <v>`, `--force`, `--force-install`. There is no flatten option.
- Bare slugs are ambiguous. `install humanizer` errors and lists the candidates
  (`@seanford/humanizer`, `@biostartechnology/humanizer`); skillbarn parses that list out of
  stderr and surfaces it instead of a raw subprocess failure.

## Traps

**`CLAWHUB_WORKDIR` and `CLAWDHUB_WORKDIR` silently redirect installs.** Both spellings
exist and either will move an install somewhere else entirely. An explicit `--workdir` does
win, but skillbarn strips both from the child environment as well.

**The lockfile lands at `<workdir>/.clawhub/lock.json`, outside the skills dir.** This is
why installs are staged outside the project — a `--workdir` pointed at the repo root drops a
`.clawhub/` directory that the managed `.gitignore` cannot cover. That file records
`version`, `installedAt` and `ownerHandle` per entry, and **no integrity digest**.

**ClawHub is blind to a flattened copy.** Re-installing over `<dir>/<slug>/` does not error
and does not detect it — it creates a *second* copy at `<dir>/@owner/slug/`. Good, in that
restore is never blocked; bad, in that a crash between install and flatten would leave a
duplicate that a recursing loader picks up twice. Staging removes this failure mode
entirely, and `skb install` sweeps any stray `@owner/` directory the lock does not claim.

**`clawhub list` reports a flattened skill as "Manually installed (not tracked by
clawhub)".** Consequence: `clawhub update --all` will not touch skillbarn-managed skills.
Drift-safe by construction, and skillbarn's lock is the only authority on what is installed.

**`clawhub update --all` means "go to latest", not "restore the locked version".** It can
rebuild a wiped skills dir from ClawHub's own lockfile, but that is not what a reproducible
install needs, so skillbarn does not use it.

## `inspect --files --json`

One call feeds both the confirmation gate and the integrity check. It returns:

- `skill.{slug,displayName,summary,description}` — `description` is the whole `SKILL.md`
  body **including frontmatter**, which is where the gate reads declared tools from
- `version.{version,license,changelog}` and the full version history
- `version.files[]` with `path`, `size` and `sha256` — the registry's own manifest
- `version.security.scanners` — per-scanner verdicts
- `owner.handle`

Per-file hashes match the installed bytes exactly for `README.md`, `SKILL.md` and
`skill-card.md`. **`_meta.json` does not** — ClawHub rewrites it locally with a different
`ownerId` and `publishedAt`. Any digest must exclude it, and `.clawhub/` with it.

## Per-skill bookkeeping

`install` writes two files into the skill that the author never published:

- `_meta.json` — `ownerId`, `slug`, `version`, `publishedAt`. The registry serves one too,
  but with different values (see above), so it cannot be verified against the manifest.
- `.clawhub/origin.json` — registry URL, slug, `ownerHandle`, `installedVersion`,
  `installedAt` and a `fingerprint` (sha256) of unverified composition. It survives the
  skill being moved, which is how it would otherwise end up inside a flattened install.

skillbarn deletes both in staging and computes its own digest, so neither reaches a project.
Verified against the live registry on 2026-08-02: after `skb add @shbernal/rfc-lookup`, the
vendored tree is `SKILL.md`, `skill-card.md` and `scripts/rfc.py` — and the integrity is
byte-identical to what a pre-strip install recorded, since both files were already excluded
from the digest. See [design](design.md#the-registry-clients-bookkeeping-is-stripped-not-vendored).

`skill-card.md` is a different case and is kept: ClawHub generates it at publish time, but
it is then served in `version.files[]` with a matching `sha256`, so it is part of the
published artifact rather than local state.
