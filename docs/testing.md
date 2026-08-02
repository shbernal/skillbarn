# Testing

The testable surface here is unusual: the logic is thin and nearly all the risk is
filesystem effects plus a subprocess. So the pyramid inverts — most of the value sits in the
middle layer, and the unit tests below it exist mainly to pin down formats.

## The seam is `PATH`, not dependency injection

skillbarn shells out to `clawhub`. A test therefore puts a fake `clawhub` earlier on `PATH`
and exercises the real code end to end: real temp directories, real `spawn`, real moves.
There is no injected runner, no mock framework, and no abstraction that exists only for
testability.

That single fact is why the subprocess boundary has to stay one small module. Widen it and
the seam stops covering the interesting code.

`test/helpers/fake-clawhub.mjs` replays fixtures from `test/fixtures/registry/` and is
configured entirely through the environment:

| variable | meaning |
|---|---|
| `FAKE_CLAWHUB_FIXTURES` | fixture root to serve from |
| `FAKE_CLAWHUB_MODE` | `ok`, `empty`, `partial-crash`, `bad-hash`, `install-fails` |
| `FAKE_CLAWHUB_LOG` | append each invocation's argv here, so tests can assert on *how* it was called |

The failure modes are the point. `bad-hash` serves bytes that disagree with the advertised
manifest, `empty` reports success and installs nothing, `partial-crash` dies mid-install,
`install-fails` exits non-zero. Each has a test asserting the project is untouched
afterwards.

It also mimics the real client where that matters: it always writes
`<workdir>/.clawhub/lock.json`, rewrites `_meta.json` after install, and emits the
multi-owner disambiguation error for an ambiguous bare slug.

## Layers

| Layer | What | Deterministic | Gates CI |
|---|---|---|---|
| 1 | Pure core — digest, gitignore render, lock reconcile, slug parse, ClawHub JSON parse. `fast-check` properties plus byte-exact snapshots. | yes | yes |
| 2 | Fake-clawhub integration. **The money layer.** | yes | yes |
| 3 | Contract tests against the real registry — shape only. | no (network) | **no** |
| 4 | Loader conformance — each loader's rule encoded as data, asserted against the produced tree. | yes | yes |
| 5 | Exploratory agent runs — charter-driven, adversarial. | no | **no** |

Layers 1, 2 and 4 exist and run in a few seconds. Layers 3 and 5 are not built yet.

Two rules about the non-deterministic layers, decided up front:

- **Layer 3 never blocks a merge.** A registry outage must not fail a PR. Nightly and
  on-demand only; drift surfaces as a reviewable fixture diff.
- **Layer 5's output contract is not pass/fail.** It is a report plus *a proposed
  deterministic test for each surprise found*, triaged by hand and promoted into layer 1 or
  2. Non-determinism stays strictly upstream of the gate — a flaky check in a blocking
  pipeline gets ignored, then deleted.

This mode has already paid for itself: the staging-workdir requirement, ClawHub's blindness
to flattened copies, and the fact that aliasing cannot resolve collisions all came out of
exactly that kind of poking, done by hand.

## One oracle, many drivers

`checkInvariants(projectDir)` in `src/invariants.ts` is the real specification. `skb verify`
calls it; the tests call it after nearly every scenario. Six invariants:

1. `lock-matches-disk` — every lock entry present and digest-matching, no unlocked directory
   except a declared-local one
2. `nothing-outside-skills-dir` — the repo root is free of `.clawhub/`
3. `install-is-a-noop` — running it again changes nothing
4. `gitignore-matches-lock` — `<dir>/.gitignore` byte-equals the render of the current lock
   keys (absent is correct while nothing is vendored)
5. `no-scoped-directories` — no `@*/` survives any command, unless `flatten: false` says so
6. `staging-torn-down` — no staging directory outlives a command, including on failure

Writing this once and calling it from both places is what stops the test suite from
encoding a second, subtly different idea of correctness.

## Fixtures

`test/fixtures/registry/` is synthetic, small, and committed: `@fixture/greeter`,
`@fixture/pdf-filler`, and `@other/greeter` to exercise collisions and ambiguity.

`scripts/record-fixtures.ts` refreshes a fixture from the live registry. It stores
ClawHub's **raw** JSON rather than skillbarn's parsed view — otherwise the fake replays a
shape the parser can never be tested against — and blanks `version.files`, since the fake
recomputes that from the recorded bytes. Running it is a network operation and deliberately
manual.
