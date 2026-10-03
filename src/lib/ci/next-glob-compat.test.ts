import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { Linter } from 'eslint'
import nextPlugin from '@next/eslint-plugin-next'

const requireFromProject = createRequire(import.meta.url)
const adapterPath = resolve('tools/next-eslint-glob/index.cjs')
const adapter = requireFromProject(adapterPath) as {
  globSync: (pattern: unknown, options: unknown) => string[]
}
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'supremo-next-glob-')))
  directories.push(root)
  for (const file of [
    'web/pages/about.tsx',
    'web/app/page.tsx',
    'web/app/dashboard/page.tsx',
    'web/examples/nested/pages/unrelated.tsx',
    'admin/src/pages/settings.tsx',
    'admin/src/app/account/page.tsx',
    '.hidden/pages/private.tsx',
    'readme.txt',
  ]) {
    const destination = join(root, file)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, '')
  }
  return root
}

function lintLinks(rootDir: string | string[] | undefined, hrefs: string[], cwd: string = process.cwd()): Linter.LintMessage[] {
  return new Linter({ cwd }).verify(
    `const content = <>${hrefs.map((href) => `<a href="${href}">Link</a>`).join('')}</>`,
    {
      files: ['**/*.jsx'],
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { '@next/next': nextPlugin },
      settings: { next: { rootDir } },
      rules: { '@next/next/no-html-link-for-pages': 'error' },
    },
    { filename: 'links.jsx' },
  )
}

describe('Next ESLint directory glob compatibility', () => {
  it('resolves the installed Next plugin to the reviewed local adapter', () => {
    const requireFromNext = createRequire(requireFromProject.resolve('@next/eslint-plugin-next'))
    expect(requireFromNext.resolve('fast-glob')).toBe(adapterPath)
    expect(Object.keys(adapter)).toEqual(['globSync'])
  })

  it('matches only the literal root, preserves absolute paths, and excludes descendants', () => {
    const root = fixture()
    expect(adapter.globSync(join(root, 'web'), { onlyDirectories: true })).toEqual([join(root, 'web')])
    expect(adapter.globSync(join(root, 'web/'), { onlyDirectories: true })).toEqual([join(root, 'web')])
  })

  it('matches relative and brace-list roots, excludes files and hidden roots, and keeps negatives empty', () => {
    const root = fixture()
    const expected = [join(root, 'admin'), join(root, 'web')].sort()
    for (const pattern of [join(root, '*'), join(root, '{web,admin}'), join(root, '{web,{admin,missing}}'), relative(process.cwd(), join(root, '*'))]) {
      expect(adapter.globSync(pattern, { onlyDirectories: true }).map((directory) => resolve(directory)).sort())
        .toEqual(expected)
    }
    expect(adapter.globSync(`!${root}/*`, { onlyDirectories: true })).toEqual([])
    expect(adapter.globSync(join(root, 'missing'), { onlyDirectories: true })).toEqual([])
    expect(adapter.globSync(join(root, 'readme.txt'), { onlyDirectories: true })).toEqual([])
  })

  it.each(['{1..12}', '{01..03}', '{1..5..2}', '{-1..2}', '{a..z}', '{web,{1..12}}', '{web}{1..12}'])(
    'fails visibly for unsupported brace ranges: %s',
    (range) => {
      expect(() => adapter.globSync(`packages/${range}`, { onlyDirectories: true })).toThrow('brace ranges are unsupported')
    },
  )

  it('rejects ranges after long malformed and nested braces without backtracking', () => {
    // Isolate the adversarial inputs so a regression times out instead of
    // blocking the entire test runner in a synchronous regex evaluation.
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict')
      const { globSync } = require(process.argv[1])
      const patterns = [
        '{' + '.'.repeat(250_000) + '{1..12}}',
        '{'.repeat(250_000) + '1..12' + '}'.repeat(250_000),
        '{}'.repeat(250_000) + '{1..12}',
      ]
      for (const pattern of patterns) {
        assert.throws(() => globSync(pattern, { onlyDirectories: true }), /brace ranges are unsupported/)
      }
    `, adapterPath], { encoding: 'utf8', timeout: 5_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it.each([
    ['web', undefined],
    ['web', {}],
    ['web', { onlyDirectories: false }],
    ['web', { onlyDirectories: true, cwd: '/' }],
    [['web'], { onlyDirectories: true }],
    ['', { onlyDirectories: true }],
  ])('fails visibly when the upstream call contract changes: %j %j', (pattern, options) => {
    expect(() => adapter.globSync(pattern, options)).toThrow(TypeError)
  })

  it('keeps the real rule active for literal roots without discovering unrelated nested apps', () => {
    const root = fixture()
    const messages = lintLinks(join(root, 'web'), ['/about', '/', '/unrelated', '/missing', 'https://example.com/about'])
    expect(messages.map((message) => message.ruleId)).toEqual([
      '@next/next/no-html-link-for-pages',
      '@next/next/no-html-link-for-pages',
    ])
    expect(messages[0]?.message).toContain('`/about/`')
    expect(messages[1]?.message).toContain('`/`')
  })

  it('keeps the real rule active for relative roots, glob roots, and rootDir arrays', () => {
    const root = fixture()
    const patterns: Array<string | string[]> = [
      relative(process.cwd(), join(root, '{web,admin}')),
      join(root, '*'),
      [join(root, 'web'), join(root, 'admin'), `!${root}/web`],
    ]
    for (const rootDir of patterns) {
      const messages = lintLinks(rootDir, ['/about', '/', '/settings'])
      expect(messages).toHaveLength(3)
      expect(messages.every((message) => message.ruleId === '@next/next/no-html-link-for-pages' && message.severity === 2)).toBe(true)
    }
  })

  it('keeps default root discovery and fails visibly through the real rule for unsupported patterns', () => {
    const root = fixture()
    const messages = lintLinks(undefined, ['/about'], join(root, 'web'))
    expect(messages).toHaveLength(1)
    expect(messages[0]?.ruleId).toBe('@next/next/no-html-link-for-pages')
    expect(() => lintLinks(join(root, '{1..12}'), ['/about'])).toThrow('brace ranges are unsupported')
  })

  it('retains the other upstream Next rules', () => {
    const messages = new Linter().verify(
      'const content = <><img src="/image.png" /><script src="/script.js" /><head><title>Title</title></head></>',
      {
        files: ['**/*.jsx'],
        languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { '@next/next': nextPlugin },
        rules: {
          '@next/next/no-img-element': 'error',
          '@next/next/no-sync-scripts': 'error',
          '@next/next/no-head-element': 'error',
        },
      },
      { filename: 'other-rules.jsx' },
    )
    expect(messages.map((message) => message.ruleId)).toEqual([
      '@next/next/no-img-element',
      '@next/next/no-sync-scripts',
      '@next/next/no-head-element',
    ])
  })
})
