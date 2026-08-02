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

## One global binary, and the project is inferred

skillbarn ships as a globally installed CLI (`pnpm add -g skillbarn`) rather than as a
project devDependency, and finds the project by walking up from the working directory.

The alternative — a devDependency plus a package script — would require a `package.json`
in every repo that wants vendored skills, and agent skills are not a JavaScript concern.
A Rust or Python repo should not have to adopt an unrelated ecosystem to get one. The
Node dependency is not really a choice either way: `clawhub` is an npm CLI, so the
runtime is already fixed.

The usual objection to a global tool is version skew — the machine, not the repo, decides
which skillbarn you get. It does not bite here because the lock records *content
digests*, not resolution decisions. A newer `skb install` reading an older lock either
reproduces the same bytes or refuses; there is no resolver whose output could drift with
the tool's version. That is a different situation from a package manager, and it is worth
saying out loud because people will assume otherwise.

`clawhub` stays a `PATH` dependency rather than an npm `dependency`. Declaring it would
pull its tree into a package that otherwise has none, and would couple skillbarn's
release cadence to a CLI whose auth and versioning are deliberately not its problem.

## Inferring the project means refusing when there is none

A global binary that guesses the project from the cwd has one failure mode a local one
does not: `skb add @owner/slug` typed in a home directory. Nothing about that directory
says "project", so the pre-refusal behaviour would have been to create `skillbarn.json`,
`skillbarn.lock` and a skills tree in `~`.

So the root has to be *identified*, not merely defaulted. `skillbarn.json` identifies it,
a `.git` directory identifies it, and a `skillbarn.lock` identifies it — that last one so a
project unpacked from a tarball, which has no `.git`, still installs. Anything else is
refused with a pointer to `skb init`, which exists precisely so there is something to point
at.

Every command but `init` refuses, the read-only ones included. `skb verify` run from the wrong
directory would otherwise report `ok` for a project it never found, and a false green in
CI is worse than the noise of one extra check.

This is the same posture as the rest of the tool: guessing is repair, and repair is what
[failure is refusal](#failure-is-refusal-not-repair) declines to do.

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

## The registry client's bookkeeping is stripped, not vendored

`clawhub install` writes two things into every skill that the skill's author never wrote:
`_meta.json`, rewritten locally with an `ownerId` and `publishedAt` that disagree with what
the registry serves, and `.clawhub/origin.json`, recording the registry URL, version and a
fingerprint. `vendorSkill()` deletes both in staging, before the tree is hashed or moved, so
neither reaches the project.

Three reasons, in order of weight.

**It closes the digest exclusion.** Anything excluded from the digest is, by construction,
bytes inside a skillbarn-guaranteed tree that `skb verify` cannot see. A `.clawhub/SKILL.md`
would be neither hashed nor locked — and OpenClaw finds `SKILL.md` anywhere under a root
([loaders](loaders.md#documented)), so it would be loaded. Stripping makes the stronger
statement true: *every file in a vendored directory is covered by the lock's integrity.*

**It removes a second answer to a settled question.** `origin.json` restates the owner,
slug and version the lock already records, next to a fingerprint whose composition is
unverified. Two authorities on what is installed is one too many, and the lock is the one
`install` and `verify` actually obey.

**It is confusing to read.** Someone opening a vendored skill should see the skill. An
opaque backend `ownerId` and a stale `installedAt` are noise to every reader, human or
agent, who did not run the install.

`skill-card.md` is **not** stripped, despite also being generated rather than authored:
ClawHub's publish pipeline produces it server-side, but the registry then serves it as part
of the version artifact with a matching `sha256`. It is published content, it carries the
license and terms, and deleting it would break "the installed tree is the published tree".
That it lands in a directory loaders walk is a real cost — but it is ClawHub's to fix by
keeping the card in registry metadata, not skillbarn's to fix by editing skills.

Two consequences worth knowing:

- The digest exclusion in `src/digest.ts` **stays**. The registry's own file manifest still
  lists `_meta.json`, so `compareFileHashes` needs it on the expected side; and trees
  installed before the strip must keep verifying against the integrity already in their
  lock. Stripping does not change any digest — it only changes what is on disk.
- `.clawhub/` inside the skills directory now means exactly one thing: someone ran `clawhub
  install` against the project directly. `checkInvariants()` reports it, because that skill
  is outside the lock's control and `skb install` will not restore it. Before the strip, the
  same evidence was ambiguous — it could equally have been an orphaned skillbarn install.

What this gives up: a lock entry deleted by hand, while its directory survives, is no longer
distinguishable from a hand-authored skill. A crash cannot produce that state — `remove`
deletes the tree before it writes the lock, so the window leaves a lock entry with no
directory, which `lock-matches-disk` already catches from the other side.

## `skillbarn.json` is intent, `skillbarn.lock` is fact

Two files at the project root, as npm has them. `add` and `remove` write both; `install`
obeys the lock alone and *reports* disagreement instead of resolving it. There is no semver
resolution and no dependency graph — skills are leaf nodes, and a resolver is where this
becomes a year of work.

`install` never writes the lock. That one rule is what makes a fresh clone reproducible:
the only way the lock changes is a human running `add` or `remove`.

## The configuration lives in the manifest, not beside it

`dir`, `flatten` and `gitignore` were a third root file for one iteration — a
`skillbarn.json` config next to a `skills.json` manifest. That pairing was wrong twice
over: it spent three files at someone's repo root for a tool this small, and it gave the
tool's own name to the file people would edit *least*.

The settings are project-shape rather than per-machine — committed, shared, identical for
everyone on the checkout — so nothing but the file boundary separated them from the
declarations, and `package.json` is the standing proof that the boundary is not needed.
Merging also removed a precedence rule instead of adding one: the config file was the
project marker but was optional, so "what makes a directory a project" had to be answered
across three files at different priorities. Now `skillbarn.json` *is* the answer, with the
lock left as the single piece of separate evidence.

The cost is real and it is paid deliberately: `add` and `remove` rewrite a file that has a
hand-authored half. So the rewrite preserves everything it does not own. Config keys are
written back exactly as they were found, unrecognized top-level keys — a `$schema`, a field
from a later skillbarn — are carried through untouched, and no key is ever added to a file
someone else wrote: materializing a default there would pin a decision nobody made against
a later change of default. `skills` renders last because it is the half that grows.

## Creating the manifest is not the same as rewriting it

The rule above is about rewrites. A manifest skillbarn *creates* has no author to
contradict, so it states its configuration in full — `dir`, `flatten` and `gitignore`, at
their defaults. `newManifest()` in `src/manifest.ts` is the single source of that file, and
`init` and `add` both go through it, so which command happened to create the project does
not show in the result.

The alternative, which was tried, is that `add` in a bare git repo writes only the `skills`
half. It keeps the never-materialize rule uniform, and the file stays honest about what was
chosen — but the settings are then in force invisibly, discoverable only from the README.
For a committed, shared file, that is the worse failure: the pinning it avoids is what a
project actually wants, since everyone on the checkout should get the same layout whatever
skillbarn they run.

Writing the file is still a surprise if nothing said it was coming, so **`add` discloses
it**. When the project has no manifest, the block above the confirmation names the file it
will create and lists the settings, and the question becomes `create skillbarn.json and
install …?`. It rides the gate `add` already asks rather than adding a second prompt: that
gate is default-no because the payload is instructions an agent will execute, and two
prompts in a row is how it stops being read. `--yes` skips it like any other confirmation;
the safety net for a directory that is *not* a project is
[the refusal](#inferring-the-project-means-refusing-when-there-is-none), not this.

## Wiring loaders up is not skillbarn's job, for now

The obvious companion to that prompt is an offer to symlink `.claude/skills` at the
vendored tree. It is declined, for three reasons that all point the same way.

It writes outside the configured skills directory, which is the one boundary that makes the
blast radius of every command statable in a sentence. Nothing would own the link afterwards
— `remove` does not clean it up, and `checkInvariants()` has no vocabulary for a path
outside the tree. And the single-loader user does not need it: `skb init --dir
.claude/skills` is already the answer, so the symlink only helps people running two loaders
over one tree, who are the people most able to run `ln -s`.

`resolveRealPath()` in `src/project.ts` already makes skillbarn correct when that symlink
exists, which is the right division: the user creates it, skillbarn follows it. If the
papercut proves common enough, it wants an explicit `skb link <loader>` with its own
confirmation and its own invariants — deferred until then, and never a rider on `add`.

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
