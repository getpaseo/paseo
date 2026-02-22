import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/contexts/daemon-registry-context'

async function loadModuleForPlatform(platform: 'web' | 'ios' | 'android') {
  vi.resetModules()
  vi.doMock('react-native', () => ({ Platform: { OS: platform } }))
  return import('./desktop-updates')
}

function createHost(input: {
  serverId: string
  endpoint: string
  type?: 'direct' | 'relay'
}): HostProfile {
  const now = new Date(0).toISOString()

  if (input.type === 'relay') {
    return {
      serverId: input.serverId,
      label: input.serverId,
      connections: [
        {
          id: `${input.serverId}-relay`,
          type: 'relay',
          relayEndpoint: input.endpoint,
          daemonPublicKeyB64: 'test-key',
        },
      ],
      preferredConnectionId: `${input.serverId}-relay`,
      createdAt: now,
      updatedAt: now,
    }
  }

  return {
    serverId: input.serverId,
    label: input.serverId,
    connections: [
      {
        id: `${input.serverId}-direct`,
        type: 'direct',
        endpoint: input.endpoint,
      },
    ],
    preferredConnectionId: `${input.serverId}-direct`,
    createdAt: now,
    updatedAt: now,
  }
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

  it('prefers localhost direct host when selecting local daemon', async () => {
    const { findLikelyLocalDaemonHost } = await loadModuleForPlatform('web')
    const remote = createHost({ serverId: 'remote', endpoint: '10.0.0.2:6767' })
    const local = createHost({ serverId: 'local', endpoint: 'localhost:6767' })

    expect(findLikelyLocalDaemonHost([remote, local])?.serverId).toBe('local')
  })

  it('falls back to first host when no localhost endpoint exists', async () => {
    const { findLikelyLocalDaemonHost } = await loadModuleForPlatform('web')
    const relay = createHost({ serverId: 'relay', endpoint: 'relay.paseo.sh:443', type: 'relay' })
    const remote = createHost({ serverId: 'remote', endpoint: '10.0.0.2:6767' })

    expect(findLikelyLocalDaemonHost([relay, remote])?.serverId).toBe('relay')
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
