import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchHomeDirectories, searchWorkspaceEntries } from './directory-suggestions.js'

describe('searchHomeDirectories', () => {
  let tempRoot: string
  let homeDir: string
  let outsideDir: string

  beforeEach(() => {
    tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'directory-suggestions-')))
    homeDir = path.join(tempRoot, 'home')
    outsideDir = path.join(tempRoot, 'outside')

    mkdirSync(homeDir, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })

    mkdirSync(path.join(homeDir, 'projects', 'junction'), { recursive: true })
    mkdirSync(path.join(homeDir, 'projects', 'playground'), { recursive: true })
    mkdirSync(path.join(homeDir, 'documents', 'plans'), { recursive: true })
    mkdirSync(path.join(homeDir, '.hidden', 'cache'), { recursive: true })
    writeFileSync(path.join(homeDir, 'projects', 'README.md'), 'not a directory\n')

    mkdirSync(path.join(outsideDir, 'outside-match'), { recursive: true })
    symlinkSync(path.join(outsideDir, 'outside-match'), path.join(homeDir, 'outside-link'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('returns an empty list for blank queries', async () => {
    await expect(
      searchHomeDirectories({
        homeDir,
        query: '   ',
        limit: 10,
      })
    ).resolves.toEqual([])
  })

  it('returns only existing directories', async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: 'proj',
      limit: 10,
    })

    expect(results).toContain(path.join(homeDir, 'projects'))
    expect(results).toContain(path.join(homeDir, 'projects', 'junction'))
    expect(results).not.toContain(path.join(homeDir, 'projects', 'README.md'))
  })

  it('supports home-relative path query syntax', async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: '~/projects/pa',
      limit: 10,
    })

    expect(results).toEqual([path.join(homeDir, 'projects', 'junction')])
  })

  it('prioritizes exact segment matches before segment-prefix matches', async () => {
    const exactSegmentPath = path.join(homeDir, 'something', 'faro', 'something-else')
    const prefixSegmentPath = path.join(homeDir, 'something', 'somethingelse', 'faro-bla')
    mkdirSync(exactSegmentPath, { recursive: true })
    mkdirSync(prefixSegmentPath, { recursive: true })

    const results = await searchHomeDirectories({
      homeDir,
      query: 'faro',
      limit: 30,
    })

    const exactIndex = results.indexOf(exactSegmentPath)
    const prefixIndex = results.indexOf(prefixSegmentPath)
    expect(exactIndex).toBeGreaterThanOrEqual(0)
    expect(prefixIndex).toBeGreaterThanOrEqual(0)
    expect(exactIndex).toBeLessThan(prefixIndex)
  })

  it('prioritizes partial matches that appear earlier in the path', async () => {
    const earlierPath = path.join(homeDir, 'farofoo')
    const laterPath = path.join(homeDir, 'x', 'y', 'farofoo')
    mkdirSync(earlierPath, { recursive: true })
    mkdirSync(laterPath, { recursive: true })

    const results = await searchHomeDirectories({
      homeDir,
      query: 'arofo',
      limit: 30,
    })

    const earlierIndex = results.indexOf(earlierPath)
    const laterIndex = results.indexOf(laterPath)
    expect(earlierIndex).toBeGreaterThanOrEqual(0)
    expect(laterIndex).toBeGreaterThanOrEqual(0)
    expect(earlierIndex).toBeLessThan(laterIndex)
  })

  it("returns home-root suggestions when query is '~'", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: '~',
      limit: 20,
    })

    expect(results).toContain(path.join(homeDir, 'projects'))
    expect(results).toContain(path.join(homeDir, 'documents'))
    expect(results).not.toContain(path.join(homeDir, '.hidden'))
  })

  it('does not return hidden directories during tree search', async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: 'cache',
      limit: 20,
    })

    expect(results).not.toContain(path.join(homeDir, '.hidden', 'cache'))
  })

  it('does not return paths that escape home through symlinks', async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: 'outside',
      limit: 20,
    })

    expect(results).not.toContain(path.join(homeDir, 'outside-link'))
    expect(results).not.toContain(path.join(outsideDir, 'outside-match'))
  })

  it('respects the result limit', async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: 'p',
      limit: 1,
    })

    expect(results).toHaveLength(1)
  })
})

describe('searchWorkspaceEntries', () => {
  let tempRoot: string
  let workspaceDir: string
  let outsideDir: string

  beforeEach(() => {
    tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'workspace-suggestions-')))
    workspaceDir = path.join(tempRoot, 'workspace')
    outsideDir = path.join(tempRoot, 'outside')

    mkdirSync(path.join(workspaceDir, 'src', 'components'), {
      recursive: true,
    })
    mkdirSync(path.join(workspaceDir, 'docs'), { recursive: true })
    mkdirSync(path.join(outsideDir, 'escaped'), { recursive: true })

    writeFileSync(path.join(workspaceDir, 'README.md'), '# junction\n')
    writeFileSync(
      path.join(workspaceDir, 'src', 'components', 'chat-input.tsx'),
      'export const ChatInput = null;\n'
    )
    writeFileSync(path.join(workspaceDir, 'docs', 'notes.md'), 'notes\n')

    symlinkSync(path.join(outsideDir, 'escaped'), path.join(workspaceDir, 'escaped-link'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('returns relative file and directory suggestions for workspace queries', async () => {
    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: 'chat',
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
    })

    expect(results).toContainEqual({
      path: 'src/components/chat-input.tsx',
      kind: 'file',
    })
    expect(results.some((entry) => entry.path === path.join(workspaceDir, 'src'))).toBe(false)
  })

  it('filters entries by kind', async () => {
    const dirsOnly = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: 'src',
      limit: 20,
      includeFiles: false,
      includeDirectories: true,
    })
    expect(dirsOnly.some((entry) => entry.kind === 'file')).toBe(false)
    expect(dirsOnly.some((entry) => entry.path === 'src')).toBe(true)

    const filesOnly = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: 'readme',
      limit: 20,
      includeFiles: true,
      includeDirectories: false,
    })
    expect(filesOnly).toEqual([{ path: 'README.md', kind: 'file' }])
  })

  it('supports path-style queries and does not escape cwd through symlinks', async () => {
    const pathResults = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: 'src/co',
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
    })
    expect(pathResults).toContainEqual({
      path: 'src/components',
      kind: 'directory',
    })

    const escapedResults = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: 'escaped',
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
    })
    expect(escapedResults.some((entry) => entry.path.includes('escaped-link'))).toBe(false)
  })

  it('ignores node_modules entries so deep workspace files still resolve under scan limits', async () => {
    mkdirSync(path.join(workspaceDir, 'packages', 'app', 'src', 'app'), { recursive: true })
    writeFileSync(path.join(workspaceDir, 'packages', 'app', 'src', 'app', '_layout.tsx'), '')

    for (let index = 0; index < 120; index += 1) {
      mkdirSync(path.join(workspaceDir, 'node_modules', `pkg-${index}`), { recursive: true })
      writeFileSync(
        path.join(workspaceDir, 'node_modules', `pkg-${index}`, 'index.js'),
        'module.exports = {};\n'
      )
    }
    writeFileSync(path.join(workspaceDir, 'node_modules', '_layout.tsx'), '')

    const results = await searchWorkspaceEntries({
      cwd: workspaceDir,
      query: '_layout.tsx',
      limit: 20,
      includeFiles: true,
      includeDirectories: true,
      maxEntriesScanned: 60,
    })

    expect(results).toContainEqual({
      path: 'packages/app/src/app/_layout.tsx',
      kind: 'file',
    })
    expect(results.some((entry) => entry.path.startsWith('node_modules/'))).toBe(false)
  })
})
