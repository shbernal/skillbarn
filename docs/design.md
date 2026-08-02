# Design

Why skillbarn is shaped the way it is. Each section records a decision and the constraint
that forced it, so the reasoning does not have to be rediscovered from the code.

## It is a wrapper, deliberately

skillbarn drives the [`clawhub`](https://www.npmjs.com/package/clawhub) CLI and never
reimplements auth, search or publishing. What it adds is the part a registry client does
not do: a project-local, gitignored install tree that is reproducible from a committed
lockfile.

The whole subprocess boundary is one small module, `src/clawhub.ts`. That is not tidiness
for its own sake — it is what makes the test seam possible (see [testing](testing.md)).

## Skills are flattened

ClawHub installs to `<dir>/@owner/slug/`. The Agent Skills spec requires `SKILL.md` at the
skill directory root but does not normatively define a scan depth for the skills *root*,
and loaders disagree: Claude Code scans one level, OpenCode globs `*/SKILL.md`, OpenClaw
finds `SKILL.md` anywhere under a root and takes identity from frontmatter.

A two-level layout is therefore a coin flip per agent. skillbarn moves each install to
`<dir>/<slug>/`, which the strictest rule accepts and the permissive ones accept for free.
The owner survives as lockfile metadata, not as a path component. This is measured, not
assumed — see [loaders](loaders.md).

Two consequences follow, and both are load-bearing:

- **Two skills with the same slug cannot both be vendored.** `skb add` hard-fails rather
  than picking a winner.
- **Renaming a directory is not a fix.** Loaders that take identity from the `name`
  frontmatter field would still see two skills called `humanizer`; rewriting that field
  would mutate vendored bytes and break the digest. So no alias mechanism is offered until
  there is one that actually works. A manifest `alias` field was designed and then dropped
  for exactly this reason: a committed file format that nothing can honour is worse than
  the honest failure.

## Installs go through a staging directory outside the project

ClawHub writes `<workdir>/.clawhub/lock.json` unconditionally. Pointing `--workdir` at the
project root would drop state in the repo that the managed `.gitignore` cannot cover, and
that is not skillbarn's state to manage anyway.

Staging (`mkdtemp` under the system temp dir) buys three things: the repo root stays clean,
flattening becomes an atomic move into place rather than an in-tree shuffle, and a failed
download never leaves a half-installed skill behind. The staging directory is removed in a
`finally`, and "no staging directory survives" is one of the checked invariants.

Related trap: `CLAWHUB_WORKDIR` / `CLAWDHUB_WORKDIR` silently redirect installs, so the
child environment is scrubbed of both and `--workdir` is always passed explicitly.

## The lock carries an integrity digest

`skb add` cross-checks the downloaded bytes against the per-file `sha256` the registry
advertises, then records a SHA-256 over the whole tree. `skb install` recomputes it and
**refuses** on a mismatch rather than warning.

Without this the lock would record what you asked for, not what you got — and that is the
main thing skillbarn offers over a shell alias, so it shipped in the first version rather
than after it. It was nearly free: the add flow already calls `clawhub inspect --files
--json` for the confirmation gate, and that one call returns the file manifest too.

The digest rule:

- paths sorted, each hashed as `` `${path} ${sha256}\n` ``, then a SHA-256 over that
- `.clawhub/` is excluded — ClawHub's local provenance, not registry content
- `_meta.json` is excluded — **ClawHub rewrites it locally.** Measured: `README.md`,
  `SKILL.md` and `skill-card.md` hash exactly as the registry manifest advertises,
  `_meta.json` does not. The exclusion is load-bearing, not defensive.
- symlinks hash as `symlink:<target>` and are never followed, so a vendored tree cannot
  make its own digest depend on something outside itself

## `skills.json` is intent, `skillbarn.lock` is fact

Two files, as npm has them. `add` and `remove` write both; `install` obeys the lock alone
and *reports* disagreement instead of resolving it. There is no semver resolution and no
dependency graph — skills are leaf nodes, and a resolver is where this becomes a year of
work.

`install` never writes the lock. That one rule is what makes a fresh clone reproducible:
the only way the lock changes is a human running `add` or `remove`.

## The ignore list is derived from the lock

Not from a path heuristic. The `@` prefix used to separate vendored from hand-authored, but
flattening removes it — and it was version-dependent anyway, since installs before ClawHub
~0.23 were unscoped. Lock keys are the only sound definition of "vendored".

`<dir>/.gitignore` is regenerated on every command from the lock, never merged with hand
edits, and carries a header that says so. Set `"gitignore": "off"` to commit the skills
instead; skillbarn then leaves the file alone, and only ever deletes a file whose header it
wrote.

Hand-authored skills sitting in the same directory are therefore untouched and stay
tracked, which is the point of deriving the list rather than ignoring the directory.

## Failure is refusal, not repair

`install` refuses to overwrite a locally modified vendored skill unless `--force`. A silent
repair would make the tamper case look like success, and an unexpected local edit is a
signal worth surfacing rather than garbage to be swept away.

The same posture runs through the rest: `add` refuses on a slug collision, refuses to write
over an unlocked directory, and refuses to install without confirmation when stdin is not a
TTY and `--yes` was not passed. `verify` is read-only and network-free so CI can run it.

## `checkInvariants()` is the specification

`src/invariants.ts` exports one function that decides whether a project is in a legal state.
`skb verify` is a driver for it; so is the test suite. There is no second, parallel
description of correctness that can drift from the first. See [testing](testing.md) for the
six invariants and why the oracle is shared.
