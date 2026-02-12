import { describe, expect, it } from 'vitest'
import {
  hostHasDirectEndpoint,
  registryHasDirectEndpoint,
  type HostProfile,
} from './daemon-registry-context'

function makeHost(input: Partial<HostProfile> & Pick<HostProfile, 'serverId'>): HostProfile {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    serverId: input.serverId,
    label: input.label ?? input.serverId,
    connections: input.connections ?? [],
    preferredConnectionId: input.preferredConnectionId ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
}

describe('hostHasDirectEndpoint', () => {
  it('returns true when host has matching direct endpoint', () => {
    const host = makeHost({
      serverId: 'srv_local',
      connections: [{ id: 'direct:localhost:6767', type: 'direct', endpoint: 'localhost:6767' }],
      preferredConnectionId: 'direct:localhost:6767',
    })

    expect(hostHasDirectEndpoint(host, 'localhost:6767')).toBe(true)
  })

  it('returns false when only relay connections exist', () => {
    const host = makeHost({
      serverId: 'srv_relay',
      connections: [
        {
          id: 'relay:relay.example:443',
          type: 'relay',
          relayEndpoint: 'relay.example:443',
          daemonPublicKeyB64: 'abcd',
        },
      ],
      preferredConnectionId: 'relay:relay.example:443',
    })

    expect(hostHasDirectEndpoint(host, 'localhost:6767')).toBe(false)
  })
})

describe('registryHasDirectEndpoint', () => {
  it('returns true when any host contains the direct endpoint', () => {
    const hosts: HostProfile[] = [
      makeHost({
        serverId: 'srv_one',
        connections: [{ id: 'direct:127.0.0.1:7777', type: 'direct', endpoint: '127.0.0.1:7777' }],
        preferredConnectionId: 'direct:127.0.0.1:7777',
      }),
      makeHost({
        serverId: 'srv_two',
        connections: [{ id: 'direct:localhost:6767', type: 'direct', endpoint: 'localhost:6767' }],
        preferredConnectionId: 'direct:localhost:6767',
      }),
    ]

    expect(registryHasDirectEndpoint(hosts, 'localhost:6767')).toBe(true)
  })

  it('returns false when no host has the endpoint', () => {
    const hosts: HostProfile[] = [
      makeHost({
        serverId: 'srv_one',
        connections: [{ id: 'direct:127.0.0.1:7777', type: 'direct', endpoint: '127.0.0.1:7777' }],
        preferredConnectionId: 'direct:127.0.0.1:7777',
      }),
    ]

    expect(registryHasDirectEndpoint(hosts, 'localhost:6767')).toBe(false)
  })
})
