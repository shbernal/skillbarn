# Working on skillbarn

Conventions for anyone — human or agent — changing this repository. What the tool does and
why is in [`docs/`](docs/); this file is about how to work on it.

## Commands

```sh
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit — biome does not typecheck
pnpm check         # biome (lint + format)
pnpm check:fix     # biome --write
pnpm build         # tsc -> dist/
pnpm publint       # lint the packed tarball; needs dist/ built first
```

`node src/cli.ts <args>` is the dev loop. **There is no watch build** and none is needed:
Node runs the TypeScript source directly, and `tsc` is a typecheck gate plus a publish-time
build, nothing more.

`bin/skb` is the same thing as an executable, for driving this checkout from another
directory — which is the only way to exercise a tool that infers the project from the cwd.
It resolves the checkout from its own path and passes the cwd through untouched, so it
survives being symlinked onto `PATH`. Do not reach for `pnpm exec` here: it moves the
process to the package root, which is exactly the input under test.

Lefthook runs Biome on staged files pre-commit, and `tsc --noEmit` + `vitest run` pre-push.
Both are cheap; do not skip them. The same gates run in GitHub Actions across Node 22, 24
and 26, plus a job that packs the tarball and runs the bin out of it.

## Releasing

Bump `version` in `package.json`, commit, then push a matching `v<version>` tag.
`.github/workflows/publish.yml` refuses a tag that disagrees with the manifest, then
publishes with provenance. There is no publish token: npm is configured to trust that
workflow in this repository and exchanges the job's OIDC identity for a short-lived
credential, which is why the job needs `id-token: write`.

That trust is bound to the workflow's **filename**, plus the owner and repository name.
Renaming any of the three breaks publishing, and it fails as a permission error that does
not mention the rename — update the trusted publisher on npmjs.com in the same change.

Do not publish by hand. A local `npm publish` produces no attestation, and `dist/` is
gitignored, so the tarball is only ever correct because `prepack` builds it. The one
exception was 0.0.1: trusted publishing cannot be configured for a package that does not
exist yet, so the first release had to come from a laptop.

## Layout

```
src/
  slug lock manifest digest gitignore frontmatter inspect gate   pure, no I/O
  fs-tree project staging vendor invariants                      touch the disk
  clawhub.ts                                                     the only subprocess
  commands/  cli.ts                                              wiring
test/
  unit/         layer 1 — properties and byte snapshots
  integration/  layer 2 — a fake clawhub on PATH, real temp dirs
  loader/       layer 4 — each loader's rule as data
  helpers/      fake-clawhub.mjs, fixture-project.ts
  fixtures/     synthetic registry
scripts/record-fixtures.ts   refresh a fixture from the live registry (network, manual)
bin/skb                      run this checkout from anywhere (dev only, not published)
```

The pure/effectful split is not aesthetic. Layer-1 tests can only stay fast and total
because the modules above the line never touch the disk, and the `PATH` test seam only works
while `clawhub.ts` is the single place that spawns anything. Keep both lines where they are.

## Rules that are load-bearing

**Zero runtime dependencies.** Including the argument parser — the surface is a handful of
commands. `devDependencies` are unconstrained.

**Relative imports carry a `.ts` extension.** `rewriteRelativeImportExtensions` rewrites
them to `.js` on emit, which is what lets the same source run under Node and build to
`dist/`. Dropping the extension is `TS5097`, and note that `tsc` still emits broken output
alongside that error.

**No `enum`, parameter properties or namespaces.** `erasableSyntaxOnly` enforces it; this is
what keeps the source runnable without a build.

**`types: ["node"]` stays explicit** in `tsconfig.json`. Automatic `@types` discovery does
not find `@types/node` under pnpm's layout.

**pnpm settings live in `pnpm-workspace.yaml`.** pnpm 11 no longer reads the `pnpm` field in
`package.json` — that is where `allowBuilds` for lefthook's postinstall hook is.

**Never write outside the configured skills directory,** and never point `clawhub
--workdir` at the project. See [docs/design.md](docs/design.md#installs-go-through-a-staging-directory-outside-the-project).
This is why skillbarn does not create the `.claude/skills` symlink for you, tempting as it
is; if that ever changes it is a `skb link <loader>` with its own invariants, not a rider on
`add`. See [docs/design.md](docs/design.md#wiring-loaders-up-is-not-skillbarns-job-for-now).

**`install` never writes the lock.** Only `add` and `remove` do.

**A manifest is written with its defaults only when it is created.** `newManifest()` in
`src/manifest.ts` is the one place that happens, and `init` and `add` share it. A *rewrite*
adds nothing — see [docs/design.md](docs/design.md#creating-the-manifest-is-not-the-same-as-rewriting-it).

**Every command but `init` refuses an unidentified project root.**
`requireIdentifiedProject()` in `src/project.ts` guards the other five, read-only ones
included. `skb` is on the global `PATH`, so a command that defaulted to the working
directory would turn a home directory into a project. See
[docs/design.md](docs/design.md#inferring-the-project-means-refusing-when-there-is-none).

## Changing behaviour

`checkInvariants()` in `src/invariants.ts` is the specification, not a helper. If a change
makes a project state legal that was not legal before, that function is what has to change,
and `skb verify` and the whole test suite follow from it. Adding an assertion to a single
test instead is how the two descriptions of correctness start to drift.

New failure paths belong in `test/integration/adversarial.test.ts`, driven by a
`FAKE_CLAWHUB_MODE` — the standard is that after any failure the project is left exactly as
it was found, and that is asserted, not assumed.

Error messages are user-facing. `SkbError` takes a message and an optional `hint`; the
message says what is wrong, the hint says what to do about it. Anything else that escapes to
the top level prints a stack, which is the correct treatment for a bug.

Prefer verifying against the live registry over reasoning about it, then record the finding
in [docs/clawhub.md](docs/clawhub.md) so the next person does not have to spend the network
call.

## Commits

Describe the change on its own terms, self-contained, imperative mood. No references to
planning documents, ticket numbers or internal labels — they mean nothing to someone reading
the history later.
