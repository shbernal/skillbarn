# Loaders: where skills have to live

Agents disagree about where a project's skills are and how deep they will look. This page
records what was measured rather than what is documented, because the two are not the same.

## Measured

Claude Code 2.1.220, probed with three skills in one project on 2026-08-02:

| location | discovered |
|---|---|
| `.claude/skills/<slug>/` | yes |
| `.claude/skills/@owner/<slug>/` | **no** |
| `.agents/skills/<slug>/` | **no** |

Two findings. The nested `@owner/slug/` layout is invisible to a strict loader, which is
why skillbarn flattens. And Claude Code does not read `.agents/skills` at all — vendored or
hand-authored makes no difference.

OpenCode was not probed. Its rule (`*/SKILL.md`, single level) is a strictly weaker
constraint than the one Claude Code was measured against, so a tree that satisfies Claude
Code satisfies it.

## Documented

OpenClaw, from its shipped docs (`docs/tools/skills.md`, `docs/help/faq.md`):

- `<workspace>/.agents/skills` **is** a project-level skill root, at precedence 2 of 6:
  `<workspace>/skills` → `<workspace>/.agents/skills` → `~/.agents/skills` →
  `~/.openclaw/skills` → bundled → `skills.load.extraDirs`.
- It finds `SKILL.md` anywhere under a root and takes skill identity from the `name`
  frontmatter field, not from the path.

So OpenClaw would find an unflattened install. Flattening is required for the strict
loaders and harmless for the permissive ones — flatten for the strictest consumer, that is
the whole argument.

The identity rule has a sharper consequence: where identity comes from frontmatter, two
skills with the same `name` collide inside the agent no matter what their directories are
called. That is why aliasing is not offered as a collision fix (see [design](design.md)).

## Choosing `dir`

| agent | set `dir` to |
|---|---|
| OpenClaw | `.agents/skills` (the default) |
| Claude Code | `.claude/skills`, or symlink `.claude/skills` → `.agents/skills` |
| OpenCode | `.agents/skills` |

skillbarn resolves symlinks (`realpath`) before writing, so if `.agents/skills` is a symlink
into `.claude/skills` — or the other way round — the managed `.gitignore` and the install
tree land in the real directory rather than beside the link. There is a test for that case.

skillbarn does **not** create those symlinks for you, and does not fan a skill out to
several agent directories. Many users already wire this up themselves and doing it silently
is overreach; alternative locations are a config knob, not magic.

## Open: should the default change?

The default `dir` is `.agents/skills`, which the most widely used agent cannot see. The
config knob covers it and the README says so, but a default that requires configuration to
work with Claude Code is a defensible choice only as long as it is a deliberate one. It has
not been revisited since the measurement above.
