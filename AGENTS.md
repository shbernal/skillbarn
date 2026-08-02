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
```

`node src/cli.ts <args>` is the dev loop. **There is no watch build** and none is needed:
Node runs the TypeScript source directly, and `tsc` is a typecheck gate plus a publish-time
build, nothing more.

Lefthook runs Biome on staged files pre-commit, and `tsc --noEmit` + `vitest run` pre-push.
Both are cheap; do not skip them.

## Layout

```
src/
  slug lock manifest digest gitignore frontmatter inspect gate   pure, no I/O
  config fs-tree project staging vendor invariants               touch the disk
  clawhub.ts                                                     the only subprocess
  commands/  cli.ts                                              wiring
test/
  unit/         layer 1 — properties and byte snapshots
  integration/  layer 2 — a fake clawhub on PATH, real temp dirs
  loader/       layer 4 — each loader's rule as data
  helpers/      fake-clawhub.mjs, fixture-project.ts
  fixtures/     synthetic registry
scripts/record-fixtures.ts   refresh a fixture from the live registry (network, manual)
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

**`install` never writes the lock.** Only `add` and `remove` do.

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
