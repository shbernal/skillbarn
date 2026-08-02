import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkbError } from '../../src/errors.ts'
import { parseFrontmatter } from '../../src/frontmatter.ts'
import { extractCommands, extractEnvVars, renderSummary, summarizeSkill } from '../../src/gate.ts'
import { parseAmbiguousSlugError, parseInspectJson } from '../../src/inspect.ts'
import { FIXTURE_REGISTRY } from '../helpers/fixture-project.ts'

const greeterInspect = await readFile(
  join(FIXTURE_REGISTRY, '@fixture', 'greeter', 'inspect.json'),
  'utf8',
)

describe('parseInspectJson', () => {
  it('reads the fields skillbarn depends on', () => {
    const result = parseInspectJson(greeterInspect)
    expect(result.slug).toBe('greeter')
    expect(result.owner).toBe('fixture')
    expect(result.version).toBe('1.2.0')
    expect(result.license).toBe('MIT')
    expect(result.security.status).toBe('clean')
    expect(result.security.scanners).toEqual({ vt: 'clean', llm: 'clean' })
  })

  it('fails loudly on a shape it does not recognise', () => {
    expect(() => parseInspectJson('{}')).toThrow(SkbError)
    expect(() => parseInspectJson('not json')).toThrow(SkbError)
    expect(() =>
      parseInspectJson(
        JSON.stringify({ skill: { slug: 'x' }, owner: { handle: 'y' }, version: { version: '1' } }),
      ),
    ).toThrow(/--files/)
  })

  it('surfaces the candidates from an ambiguous-slug error', () => {
    const stderr =
      'Multiple skills named "humanizer":\n  @seanford/humanizer\n  @biostartechnology/humanizer\n'
    expect(parseAmbiguousSlugError(stderr)).toEqual([
      '@seanford/humanizer',
      '@biostartechnology/humanizer',
    ])
  })
})

describe('frontmatter', () => {
  it('reads scalars, block scalars and inline lists', () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\nname: greeter\ndescription: |\n  line one\n  line two\nallowed-tools: [Read, Write]\n---\n\nbody text\n',
    )
    expect(frontmatter.name).toBe('greeter')
    expect(frontmatter.description).toBe('line one\nline two')
    expect(frontmatter['allowed-tools']).toEqual(['Read', 'Write'])
    expect(body.trim()).toBe('body text')
  })

  it('reads dash sequences', () => {
    const { frontmatter } = parseFrontmatter('---\ntags:\n  - one\n  - two\n---\nbody\n')
    expect(frontmatter.tags).toEqual(['one', 'two'])
  })

  it('leaves a document without frontmatter alone', () => {
    expect(parseFrontmatter('# just markdown\n')).toEqual({
      frontmatter: {},
      body: '# just markdown\n',
    })
    expect(parseFrontmatter('---\nunterminated: yes\n').frontmatter).toEqual({})
  })
})

describe('the add gate', () => {
  it('names the commands and env vars the skill text mentions', () => {
    const summary = summarizeSkill(parseInspectJson(greeterInspect))
    expect(summary.commands).toEqual(['curl', 'jq'])
    expect(summary.envVars).toEqual(['GREETER_ENDPOINT'])
    expect(summary.allowedTools).toEqual(['Read', 'Write'])
    expect(summary.fileCount).toBe(0) // the fixture template carries no file list; the fake fills it in
  })

  it('ignores shell keywords and non-shell fences', () => {
    expect(extractCommands('```bash\nif true; then\n  rm -rf /tmp/x\nfi\n```\n')).toEqual(['rm'])
    expect(extractCommands('```js\nfetch("https://evil.example")\n```\n')).toEqual([])
    expect(extractCommands('```\nrm -rf /\n```\n')).toEqual([])
  })

  it('skips env vars that say nothing about the skill', () => {
    expect(extractEnvVars('use $PATH and $HOME and $API_TOKEN')).toEqual(['API_TOKEN'])
    expect(extractEnvVars('process.env.OPENAI_KEY')).toEqual(['OPENAI_KEY'])
  })

  it('renders a summary that says what the scan is worth', () => {
    const rendered = renderSummary(summarizeSkill(parseInspectJson(greeterInspect)))
    expect(rendered).toContain('@fixture/greeter@1.2.0')
    expect(rendered).toContain('heuristic, not a sandbox report')
    expect(rendered).toContain('GREETER_ENDPOINT')
  })
})
