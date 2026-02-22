import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadModuleForPlatform(platform: 'web' | 'ios' | 'android') {
  vi.resetModules()
  vi.doMock('react-native', () => ({ Platform: { OS: platform } }))
  return import('./desktop-updates')
}

describe('desktop-updates helpers', () => {
  afterEach(() => {
    vi.doUnmock('react-native')
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('normalizes versions for app-daemon comparisons', async () => {
    const { normalizeVersionForComparison } = await loadModuleForPlatform('web')

    expect(normalizeVersionForComparison(' v0.1.15 ')).toBe('0.1.15')
    expect(normalizeVersionForComparison('0.1.15')).toBe('0.1.15')
    expect(normalizeVersionForComparison(null)).toBeNull()
  })

  it('detects version mismatch after normalization', async () => {
    const { isVersionMismatch } = await loadModuleForPlatform('web')

    expect(isVersionMismatch('v0.1.15', '0.1.15')).toBe(false)
    expect(isVersionMismatch('0.1.15', '0.1.16')).toBe(true)
    expect(isVersionMismatch('0.1.15', null)).toBe(false)
  })

  it('formats display versions with v prefix and unavailable fallback', async () => {
    const { formatVersionWithPrefix } = await loadModuleForPlatform('web')

    expect(formatVersionWithPrefix('0.2.0')).toBe('v0.2.0')
    expect(formatVersionWithPrefix('v0.2.0')).toBe('v0.2.0')
    expect(formatVersionWithPrefix(null)).toBe('\u2014')
  })

  it('parses valid local daemon version result', async () => {
    const { parseLocalDaemonVersionResult } = await loadModuleForPlatform('web')

    expect(parseLocalDaemonVersionResult({ version: '0.1.15', error: null })).toEqual({
      version: '0.1.15',
      error: null,
    })
  })

  it('parses local daemon version error result', async () => {
    const { parseLocalDaemonVersionResult } = await loadModuleForPlatform('web')

    expect(
      parseLocalDaemonVersionResult({ version: null, error: 'paseo command not found in PATH' })
    ).toEqual({
      version: null,
      error: 'paseo command not found in PATH',
    })
  })

  it('parses unexpected local daemon version result', async () => {
    const { parseLocalDaemonVersionResult } = await loadModuleForPlatform('web')

    expect(parseLocalDaemonVersionResult(null)).toEqual({
      version: null,
      error: 'Unexpected response from version check.',
    })

    expect(parseLocalDaemonVersionResult('not an object')).toEqual({
      version: null,
      error: 'Unexpected response from version check.',
    })
  })

  it('trims whitespace in parsed version', async () => {
    const { parseLocalDaemonVersionResult } = await loadModuleForPlatform('web')

    expect(parseLocalDaemonVersionResult({ version: ' 0.1.15 ', error: null })).toEqual({
      version: '0.1.15',
      error: null,
    })
  })

  it('builds copyable daemon update diagnostics', async () => {
    const { buildDaemonUpdateDiagnostics } = await loadModuleForPlatform('web')
    const diagnostics = buildDaemonUpdateDiagnostics({
      exitCode: 1,
      stdout: 'stdout text',
      stderr: 'stderr text',
    })

    expect(diagnostics).toContain('Exit code: 1')
    expect(diagnostics).toContain('STDOUT:\nstdout text')
    expect(diagnostics).toContain('STDERR:\nstderr text')
  })
})
