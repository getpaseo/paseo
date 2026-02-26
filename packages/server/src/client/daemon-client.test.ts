import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest'
import { DaemonClient, type DaemonTransport } from './daemon-client'
import {
  BinaryMuxChannel,
  TerminalBinaryMessageType,
  asUint8Array,
  decodeBinaryMuxFrame,
  encodeBinaryMuxFrame,
} from '../shared/binary-mux.js'

expectTypeOf<'getGitDiff' extends keyof DaemonClient ? true : false>().toEqualTypeOf<false>()
expectTypeOf<
  'getHighlightedDiff' extends keyof DaemonClient ? true : false
>().toEqualTypeOf<false>()

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function createMockTransport() {
  const sent: Array<string | Uint8Array | ArrayBuffer> = []

  let onMessage: (data: unknown) => void = () => {}
  let onOpen: () => void = () => {}
  let onClose: (_event?: unknown) => void = () => {}
  let onError: (_event?: unknown) => void = () => {}
  let welcomeOrdinal = 1

  const transport: DaemonTransport = {
    send: (data) => sent.push(data),
    close: () => {},
    onMessage: (handler) => {
      onMessage = handler
      return () => {}
    },
    onOpen: (handler) => {
      onOpen = handler
      return () => {}
    },
    onClose: (handler) => {
      onClose = handler
      return () => {}
    },
    onError: (handler) => {
      onError = handler
      return () => {}
    },
  }

  return {
    transport,
    sent,
    triggerOpen: () => {
      onOpen()
      // Ignore HELLO handshake payloads in assertions.
      sent.length = 0
      onMessage(
        JSON.stringify({
          type: 'welcome',
          serverId: `srv_test_${welcomeOrdinal++}`,
          hostname: null,
          version: null,
          resumed: false,
        })
      )
    },
    triggerClose: (event?: unknown) => onClose(event),
    triggerError: (event?: unknown) => onError(event),
    triggerMessage: (data: unknown) => onMessage(data),
  }
}

function wrapSessionMessage(message: unknown): string {
  return JSON.stringify({
    type: 'session',
    message,
  })
}

describe('DaemonClient', () => {
  const clients: DaemonClient[] = []

  afterEach(async () => {
    for (const client of clients) {
      await client.close()
    }
    clients.length = 0
  })

  test('dedupes in-flight checkout status requests per agentId', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const p1 = client.getCheckoutStatus('/tmp/project')
    const p2 = client.getCheckoutStatus('/tmp/project')

    expect(mock.sent).toHaveLength(1)

    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: { type: 'checkout_status_request'; cwd: string; requestId: string }
    }

    const response = {
      type: 'session',
      message: {
        type: 'checkout_status_response',
        payload: {
          cwd: '/tmp/project',
          error: null,
          requestId: request.message.requestId,
          isGit: false,
          isJunctionOwnedWorktree: false,
          repoRoot: null,
          currentBranch: null,
          isDirty: null,
          baseRef: null,
          aheadBehind: null,
          aheadOfOrigin: null,
          behindOfOrigin: null,
          hasRemote: false,
          remoteUrl: null,
        },
      },
    }

    mock.triggerMessage(JSON.stringify(response))
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toMatchObject({
      cwd: '/tmp/project',
      requestId: request.message.requestId,
      isGit: false,
    })
    expect(r2).toMatchObject({
      cwd: '/tmp/project',
      requestId: request.message.requestId,
      isGit: false,
    })

    // After completion, a new call should issue a new request.
    const p3 = client.getCheckoutStatus('/tmp/project')
    expect(mock.sent).toHaveLength(2)

    const request2 = JSON.parse(mock.sent[1]) as {
      type: 'session'
      message: { type: 'checkout_status_request'; cwd: string; requestId: string }
    }

    mock.triggerMessage(
      JSON.stringify({
        ...response,
        message: {
          ...response.message,
          payload: { ...response.message.payload, requestId: request2.message.requestId },
        },
      })
    )

    await expect(p3).resolves.toMatchObject({
      cwd: '/tmp/project',
      requestId: request2.message.requestId,
      isGit: false,
    })
  })

  test('does not reconnect after close when ensureConnected is called', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise
    expect(client.getConnectionState().status).toBe('connected')

    await client.close()
    expect(client.getConnectionState().status).toBe('disposed')

    client.ensureConnected()
    expect(client.getConnectionState().status).toBe('disposed')
  })

  test('sends explicit shutdown_server_request via shutdownServer', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const lifecycleClient = client as unknown as {
      shutdownServer: (requestId?: string) => Promise<{
        status: 'shutdown_requested'
        clientId: string
        requestId: string
      }>
    }

    expect(typeof lifecycleClient.shutdownServer).toBe('function')
    const promise = lifecycleClient.shutdownServer('req-shutdown-1')

    expect(mock.sent).toHaveLength(1)
    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: {
        type: string
        requestId: string
      }
    }
    expect(request.message).toEqual({
      type: 'shutdown_server_request',
      requestId: 'req-shutdown-1',
    })

    mock.triggerMessage(
      wrapSessionMessage({
        type: 'status',
        payload: {
          status: 'shutdown_requested',
          clientId: 'clsk_unit_test',
          requestId: 'req-shutdown-1',
        },
      })
    )

    await expect(promise).resolves.toEqual({
      status: 'shutdown_requested',
      clientId: 'clsk_unit_test',
      requestId: 'req-shutdown-1',
    })
  })

  test('restartServer remains restart-only and sends restart_server_request', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const promise = client.restartServer('settings_update', 'req-restart-1')

    expect(mock.sent).toHaveLength(1)
    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: {
        type: string
        reason?: string
        requestId: string
      }
    }
    expect(request.message).toEqual({
      type: 'restart_server_request',
      reason: 'settings_update',
      requestId: 'req-restart-1',
    })

    mock.triggerMessage(
      wrapSessionMessage({
        type: 'status',
        payload: {
          status: 'restart_requested',
          clientId: 'clsk_unit_test',
          reason: 'settings_update',
          requestId: 'req-restart-1',
        },
      })
    )

    await expect(promise).resolves.toEqual({
      status: 'restart_requested',
      clientId: 'clsk_unit_test',
      reason: 'settings_update',
      requestId: 'req-restart-1',
    })
  })

  test('transitions out of connecting when connect timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      const logger = createMockLogger()
      const mock = createMockTransport()

      const client = new DaemonClient({
        url: 'ws://test',
        clientId: 'clsk_unit_test',
        logger,
        reconnect: { enabled: false },
        connectTimeoutMs: 100,
        transportFactory: () => mock.transport,
      })
      clients.push(client)

      const pendingConnect = client.connect().then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error })
      )
      expect(client.getConnectionState().status).toBe('connecting')

      await vi.advanceTimersByTimeAsync(120)
      const result = await pendingConnect
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error)
        expect((result.error as Error).message).toContain('Connection timed out')
      }
      expect(client.getConnectionState().status).toBe('disconnected')
    } finally {
      vi.useRealTimers()
    }
  })

  test('reconnects after relay close with replaced-by-new-connection reason', async () => {
    vi.useFakeTimers()
    try {
      const logger = createMockLogger()
      const first = createMockTransport()
      const second = createMockTransport()
      const transports = [first, second]
      let transportIndex = 0

      const client = new DaemonClient({
        url: 'ws://relay.test/ws?role=client&serverId=srv_test&v=2',
        clientId: 'clsk_test',
        logger,
        reconnect: {
          enabled: true,
          baseDelayMs: 5,
          maxDelayMs: 5,
        },
        transportFactory: () => {
          const next = transports[Math.min(transportIndex, transports.length - 1)]
          transportIndex += 1
          return next.transport
        },
      })
      clients.push(client)

      const connectPromise = client.connect()
      first.triggerOpen()
      await connectPromise
      expect(client.getConnectionState().status).toBe('connected')

      first.triggerClose({ code: 1008, reason: 'Replaced by new connection' })
      expect(client.getConnectionState().status).toBe('disconnected')

      await vi.advanceTimersByTimeAsync(10)
      expect(client.getConnectionState().status).toBe('connecting')

      second.triggerOpen()
      expect(client.getConnectionState().status).toBe('connected')
    } finally {
      vi.useRealTimers()
    }
  })

  test('requires non-empty clientId', () => {
    expect(() => {
      new DaemonClient({
        url: 'ws://relay.test/ws?role=client&serverId=srv_test&v=2',
        clientId: '',
        reconnect: { enabled: false },
      })
    }).toThrow('Daemon client requires a non-empty clientId')
  })

  test('requires non-empty clientId for direct connections', () => {
    expect(() => {
      new DaemonClient({
        url: 'ws://127.0.0.1:6767/ws',
        clientId: '   ',
        reconnect: { enabled: false },
      })
    }).toThrow('Daemon client requires a non-empty clientId')
  })

  test('logs configured runtime generation in connection transition events', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      runtimeGeneration: 7,
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const transitionPayloads = logger.debug.mock.calls
      .filter(([, message]) => message === 'DaemonClientTransition')
      .map(([payload]) => payload as { generation?: number | null })
    expect(transitionPayloads.length).toBeGreaterThan(0)
    for (const payload of transitionPayloads) {
      expect(payload.generation).toBe(7)
    }
  })

  test('subscribes to checkout diff updates via RPC handshake', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const promise = client.subscribeCheckoutDiff(
      '/tmp/project',
      { mode: 'uncommitted' },
      { subscriptionId: 'checkout-sub-1' }
    )

    expect(mock.sent).toHaveLength(1)
    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: {
        type: 'subscribe_checkout_diff_request'
        subscriptionId: string
        cwd: string
        compare: { mode: 'uncommitted' | 'base'; baseRef?: string }
        requestId: string
      }
    }
    expect(request.message.type).toBe('subscribe_checkout_diff_request')
    expect(request.message.subscriptionId).toBe('checkout-sub-1')
    expect(request.message.cwd).toBe('/tmp/project')
    expect(request.message.compare).toEqual({ mode: 'uncommitted' })

    mock.triggerMessage(
      JSON.stringify({
        type: 'session',
        message: {
          type: 'subscribe_checkout_diff_response',
          payload: {
            subscriptionId: 'checkout-sub-1',
            cwd: '/tmp/project',
            files: [],
            error: null,
            requestId: request.message.requestId,
          },
        },
      })
    )

    await expect(promise).resolves.toEqual({
      subscriptionId: 'checkout-sub-1',
      cwd: '/tmp/project',
      files: [],
      error: null,
      requestId: request.message.requestId,
    })
  })

  test('getCheckoutDiff uses one-shot subscription protocol', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const promise = client.getCheckoutDiff('/tmp/project', { mode: 'base', baseRef: 'main' })

    expect(mock.sent).toHaveLength(1)
    const subscribeRequest = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: {
        type: 'subscribe_checkout_diff_request'
        subscriptionId: string
        cwd: string
        compare: { mode: 'uncommitted' | 'base'; baseRef?: string }
        requestId: string
      }
    }
    expect(subscribeRequest.message.type).toBe('subscribe_checkout_diff_request')
    expect(subscribeRequest.message.cwd).toBe('/tmp/project')
    expect(subscribeRequest.message.compare).toEqual({ mode: 'base', baseRef: 'main' })

    mock.triggerMessage(
      JSON.stringify({
        type: 'session',
        message: {
          type: 'subscribe_checkout_diff_response',
          payload: {
            subscriptionId: subscribeRequest.message.subscriptionId,
            cwd: '/tmp/project',
            files: [],
            error: null,
            requestId: subscribeRequest.message.requestId,
          },
        },
      })
    )

    await expect(promise).resolves.toEqual({
      cwd: '/tmp/project',
      files: [],
      error: null,
      requestId: subscribeRequest.message.requestId,
    })

    expect(mock.sent).toHaveLength(2)
    const unsubscribeRequest = JSON.parse(mock.sent[1]) as {
      type: 'session'
      message: {
        type: 'unsubscribe_checkout_diff_request'
        subscriptionId: string
      }
    }
    expect(unsubscribeRequest.message.type).toBe('unsubscribe_checkout_diff_request')
    expect(unsubscribeRequest.message.subscriptionId).toBe(subscribeRequest.message.subscriptionId)
  })

  test('requests branch suggestions via RPC', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const promise = client.getBranchSuggestions(
      { cwd: '/tmp/project', query: 'mai', limit: 5 },
      'req-branches'
    )

    expect(mock.sent).toHaveLength(1)
    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: {
        type: 'branch_suggestions_request'
        cwd: string
        query?: string
        limit?: number
        requestId: string
      }
    }
    expect(request.message.type).toBe('branch_suggestions_request')
    expect(request.message.cwd).toBe('/tmp/project')
    expect(request.message.query).toBe('mai')
    expect(request.message.limit).toBe(5)
    expect(request.message.requestId).toBe('req-branches')

    mock.triggerMessage(
      JSON.stringify({
        type: 'session',
        message: {
          type: 'branch_suggestions_response',
          payload: {
            branches: ['main'],
            error: null,
            requestId: 'req-branches',
          },
        },
      })
    )

    await expect(promise).resolves.toEqual({
      branches: ['main'],
      error: null,
      requestId: 'req-branches',
    })
  })

  test('requests directory suggestions via RPC', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const promise = client.getDirectorySuggestions(
      {
        query: 'proj',
        limit: 10,
        cwd: '/tmp/project',
        includeFiles: true,
        includeDirectories: true,
      },
      'req-directories'
    )

    expect(mock.sent).toHaveLength(1)
    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: {
        type: 'directory_suggestions_request'
        query: string
        cwd?: string
        includeFiles?: boolean
        includeDirectories?: boolean
        limit?: number
        requestId: string
      }
    }
    expect(request.message.type).toBe('directory_suggestions_request')
    expect(request.message.query).toBe('proj')
    expect(request.message.cwd).toBe('/tmp/project')
    expect(request.message.includeFiles).toBe(true)
    expect(request.message.includeDirectories).toBe(true)
    expect(request.message.limit).toBe(10)
    expect(request.message.requestId).toBe('req-directories')

    mock.triggerMessage(
      JSON.stringify({
        type: 'session',
        message: {
          type: 'directory_suggestions_response',
          payload: {
            directories: ['/Users/test/projects/junction'],
            entries: [{ path: 'README.md', kind: 'file' }],
            error: null,
            requestId: 'req-directories',
          },
        },
      })
    )

    await expect(promise).resolves.toEqual({
      directories: ['/Users/test/projects/junction'],
      entries: [{ path: 'README.md', kind: 'file' }],
      error: null,
      requestId: 'req-directories',
    })
  })

  test('requests checkout merge from base via RPC', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const promise = client.checkoutMergeFromBase(
      '/tmp/project',
      { baseRef: 'main', requireCleanTarget: true },
      'req-merge-from-base'
    )

    expect(mock.sent).toHaveLength(1)
    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: {
        type: 'checkout_merge_from_base_request'
        cwd: string
        baseRef?: string
        requireCleanTarget?: boolean
        requestId: string
      }
    }
    expect(request.message.type).toBe('checkout_merge_from_base_request')
    expect(request.message.cwd).toBe('/tmp/project')
    expect(request.message.baseRef).toBe('main')
    expect(request.message.requireCleanTarget).toBe(true)
    expect(request.message.requestId).toBe('req-merge-from-base')

    mock.triggerMessage(
      JSON.stringify({
        type: 'session',
        message: {
          type: 'checkout_merge_from_base_response',
          payload: {
            cwd: '/tmp/project',
            requestId: 'req-merge-from-base',
            success: true,
            error: null,
          },
        },
      })
    )

    await expect(promise).resolves.toEqual({
      cwd: '/tmp/project',
      requestId: 'req-merge-from-base',
      success: true,
      error: null,
    })
  })

  test('resubscribes checkout diff streams after reconnect', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const internal = client as unknown as {
      checkoutDiffSubscriptions: Map<
        string,
        { cwd: string; compare: { mode: 'uncommitted' | 'base'; baseRef?: string } }
      >
    }
    internal.checkoutDiffSubscriptions.set('checkout-sub-1', {
      cwd: '/tmp/project',
      compare: { mode: 'base', baseRef: 'main' },
    })

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    expect(mock.sent).toHaveLength(1)
    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: {
        type: 'subscribe_checkout_diff_request'
        subscriptionId: string
        cwd: string
        compare: { mode: 'uncommitted' | 'base'; baseRef?: string }
        requestId: string
      }
    }
    expect(request.message.type).toBe('subscribe_checkout_diff_request')
    expect(request.message.subscriptionId).toBe('checkout-sub-1')
    expect(request.message.cwd).toBe('/tmp/project')
    expect(request.message.compare).toEqual({ mode: 'base', baseRef: 'main' })
    expect(typeof request.message.requestId).toBe('string')
    expect(request.message.requestId.length).toBeGreaterThan(0)
  })

  test('fetches agents via RPC with filters, sort, and pagination', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const promise = client.fetchAgents({
      filter: { labels: { ui: 'true' } },
      sort: [
        { key: 'status_priority', direction: 'asc' },
        { key: 'created_at', direction: 'desc' },
      ],
      page: { limit: 25, cursor: 'cursor-1' },
      subscribe: { subscriptionId: 'sub-1' },
    })

    expect(mock.sent).toHaveLength(1)
    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: {
        type: 'fetch_agents_request'
        requestId: string
        filter?: { labels?: Record<string, string> }
        sort?: Array<{
          key: 'status_priority' | 'created_at' | 'updated_at' | 'title'
          direction: 'asc' | 'desc'
        }>
        page?: { limit: number; cursor?: string }
        subscribe?: { subscriptionId?: string }
      }
    }
    expect(request.message.type).toBe('fetch_agents_request')
    expect(request.message.sort).toEqual([
      { key: 'status_priority', direction: 'asc' },
      { key: 'created_at', direction: 'desc' },
    ])
    expect(request.message.page).toEqual({ limit: 25, cursor: 'cursor-1' })
    expect(request.message.subscribe).toEqual({ subscriptionId: 'sub-1' })

    mock.triggerMessage(
      JSON.stringify({
        type: 'session',
        message: {
          type: 'fetch_agents_response',
          payload: {
            requestId: request.message.requestId,
            subscriptionId: 'sub-1',
            entries: [],
            pageInfo: {
              nextCursor: null,
              prevCursor: 'cursor-1',
              hasMore: false,
            },
          },
        },
      })
    )

    await expect(promise).resolves.toEqual({
      requestId: request.message.requestId,
      subscriptionId: 'sub-1',
      entries: [],
      pageInfo: {
        nextCursor: null,
        prevCursor: 'cursor-1',
        hasMore: false,
      },
    })
  })

  test('uses server-provided dictation finish timeout budget', async () => {
    vi.useFakeTimers()
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const finishPromise = client.finishDictationStream('dict-1', 0)
    const finishError = finishPromise.then(
      () => null,
      (error) => error
    )

    expect(mock.sent).toHaveLength(1)
    mock.triggerMessage(
      wrapSessionMessage({
        type: 'dictation_stream_finish_accepted',
        payload: {
          dictationId: 'dict-1',
          timeoutMs: 100,
        },
      })
    )

    await vi.advanceTimersByTimeAsync(5_101)
    const error = await finishError
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(
      'Timeout waiting for dictation finalization (5100ms)'
    )

    vi.useRealTimers()
  })

  test('resolves dictation finish when final arrives after finish accepted', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const finishPromise = client.finishDictationStream('dict-2', 1)
    expect(mock.sent).toHaveLength(1)

    mock.triggerMessage(
      wrapSessionMessage({
        type: 'dictation_stream_finish_accepted',
        payload: {
          dictationId: 'dict-2',
          timeoutMs: 1000,
        },
      })
    )
    mock.triggerMessage(
      wrapSessionMessage({
        type: 'dictation_stream_final',
        payload: {
          dictationId: 'dict-2',
          text: 'hello',
        },
      })
    )

    await expect(finishPromise).resolves.toEqual({
      dictationId: 'dict-2',
      text: 'hello',
    })
  })

  test('cancels waiters when send fails (no leaked timeouts)', async () => {
    vi.useFakeTimers()
    const logger = createMockLogger()
    const mock = createMockTransport()
    let sendCount = 0

    const transportFactory = () => ({
      ...mock.transport,
      send: () => {
        sendCount += 1
        if (sendCount > 1) {
          throw new Error('boom')
        }
      },
    })

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const promise = client.getCheckoutStatus('/tmp/project')
    await expect(promise).rejects.toThrow('boom')

    // Ensure we didn't leave a waiter behind that will reject later.
    const internal = client as unknown as { waiters: Set<unknown> }
    expect(internal.waiters.size).toBe(0)

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  test('lists available providers via RPC', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const promise = client.listAvailableProviders()
    expect(mock.sent).toHaveLength(1)

    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: { type: 'list_available_providers_request'; requestId: string }
    }
    expect(request.message.type).toBe('list_available_providers_request')

    mock.triggerMessage(
      JSON.stringify({
        type: 'session',
        message: {
          type: 'list_available_providers_response',
          payload: {
            providers: [
              { provider: 'claude', available: true, error: null },
              { provider: 'codex', available: false, error: 'Missing binary' },
            ],
            error: null,
            fetchedAt: '2026-02-12T00:00:00.000Z',
            requestId: request.message.requestId,
          },
        },
      })
    )

    await expect(promise).resolves.toEqual({
      providers: [
        { provider: 'claude', available: true, error: null },
        { provider: 'codex', available: false, error: 'Missing binary' },
      ],
      error: null,
      fetchedAt: '2026-02-12T00:00:00.000Z',
      requestId: request.message.requestId,
    })
  })

  test('lists commands with draft config via RPC', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const promise = client.listCommands('__new_agent__', {
      draftConfig: {
        provider: 'codex',
        cwd: '/tmp/project',
        modeId: 'bypassPermissions',
        model: 'gpt-5',
        thinkingOptionId: 'off',
      },
    })
    expect(mock.sent).toHaveLength(1)

    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: {
        type: 'list_commands_request'
        agentId: string
        draftConfig?: {
          provider: string
          cwd: string
          modeId?: string
          model?: string
          thinkingOptionId?: string
        }
        requestId: string
      }
    }
    expect(request.message.type).toBe('list_commands_request')
    expect(request.message.agentId).toBe('__new_agent__')
    expect(request.message.draftConfig).toEqual({
      provider: 'codex',
      cwd: '/tmp/project',
      modeId: 'bypassPermissions',
      model: 'gpt-5',
      thinkingOptionId: 'off',
    })

    mock.triggerMessage(
      JSON.stringify({
        type: 'session',
        message: {
          type: 'list_commands_response',
          payload: {
            agentId: '__new_agent__',
            commands: [{ name: 'help', description: 'Show help', argumentHint: '' }],
            error: null,
            requestId: request.message.requestId,
          },
        },
      })
    )

    await expect(promise).resolves.toEqual({
      agentId: '__new_agent__',
      commands: [{ name: 'help', description: 'Show help', argumentHint: '' }],
      error: null,
      requestId: request.message.requestId,
    })
  })

  test('lists commands with legacy requestId signature via RPC', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const promise = client.listCommands('agent-1', 'req-legacy')
    expect(mock.sent).toHaveLength(1)

    const request = JSON.parse(mock.sent[0]) as {
      type: 'session'
      message: {
        type: 'list_commands_request'
        agentId: string
        draftConfig?: unknown
        requestId: string
      }
    }
    expect(request.message.type).toBe('list_commands_request')
    expect(request.message.agentId).toBe('agent-1')
    expect(request.message.requestId).toBe('req-legacy')
    expect(request.message.draftConfig).toBeUndefined()

    mock.triggerMessage(
      JSON.stringify({
        type: 'session',
        message: {
          type: 'list_commands_response',
          payload: {
            agentId: 'agent-1',
            commands: [],
            error: null,
            requestId: 'req-legacy',
          },
        },
      })
    )

    await expect(promise).resolves.toEqual({
      agentId: 'agent-1',
      commands: [],
      error: null,
      requestId: 'req-legacy',
    })
  })

  test('auto-acks terminal stream chunks after delivery', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const seen: string[] = []
    const decoder = new TextDecoder()
    const unsubscribe = client.onTerminalStreamData(7, (chunk) => {
      seen.push(decoder.decode(chunk.data))
    })

    const payload = new TextEncoder().encode('hello')
    mock.triggerMessage(
      encodeBinaryMuxFrame({
        channel: BinaryMuxChannel.Terminal,
        messageType: TerminalBinaryMessageType.OutputUtf8,
        streamId: 7,
        offset: 10,
        payload,
      })
    )

    expect(seen).toEqual(['hello'])
    expect(mock.sent).toHaveLength(1)
    const ackBytes = asUint8Array(mock.sent[0])
    expect(ackBytes).not.toBeNull()
    const ackFrame = decodeBinaryMuxFrame(ackBytes!)
    expect(ackFrame).not.toBeNull()
    expect(ackFrame!.channel).toBe(BinaryMuxChannel.Terminal)
    expect(ackFrame!.messageType).toBe(TerminalBinaryMessageType.Ack)
    expect(ackFrame!.streamId).toBe(7)
    expect(ackFrame!.offset).toBe(15)
    unsubscribe()
  })

  test('handles terminal binary frames delivered as UTF-8 strings', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const seen: string[] = []
    client.onTerminalStreamData(11, (chunk) => {
      seen.push(new TextDecoder().decode(chunk.data))
    })

    const payload = new TextEncoder().encode('ls\r\n')
    const frame = encodeBinaryMuxFrame({
      channel: BinaryMuxChannel.Terminal,
      messageType: TerminalBinaryMessageType.OutputUtf8,
      streamId: 11,
      offset: 0,
      payload,
    })
    const frameAsString = new TextDecoder('utf-8', { fatal: true }).decode(frame)

    mock.triggerMessage(frameAsString)

    expect(seen).toEqual(['ls\r\n'])
    expect(mock.sent).toHaveLength(1)
    const ackFrame = decodeBinaryMuxFrame(asUint8Array(mock.sent[0])!)
    expect(ackFrame?.channel).toBe(BinaryMuxChannel.Terminal)
    expect(ackFrame?.messageType).toBe(TerminalBinaryMessageType.Ack)
    expect(ackFrame?.streamId).toBe(11)
    expect(ackFrame?.offset).toBe(4)
  })

  test('acks buffered terminal chunks when handler is attached', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    mock.triggerMessage(
      encodeBinaryMuxFrame({
        channel: BinaryMuxChannel.Terminal,
        messageType: TerminalBinaryMessageType.OutputUtf8,
        streamId: 19,
        offset: 0,
        payload: new TextEncoder().encode('buffered'),
      })
    )

    expect(mock.sent).toHaveLength(1)
    const bufferedAck = decodeBinaryMuxFrame(asUint8Array(mock.sent[0])!)
    expect(bufferedAck?.messageType).toBe(TerminalBinaryMessageType.Ack)
    expect(bufferedAck?.streamId).toBe(19)
    expect(bufferedAck?.offset).toBe(8)
    mock.sent.length = 0

    const seen: string[] = []
    client.onTerminalStreamData(19, (chunk) => {
      seen.push(new TextDecoder().decode(chunk.data))
    })

    expect(seen.join('')).toContain('buffered')
    expect(mock.sent).toHaveLength(0)
  })

  test('stops delivering and acking after terminal_stream_exit', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const seen: string[] = []
    const unsubscribe = client.onTerminalStreamData(23, (chunk) => {
      seen.push(new TextDecoder().decode(chunk.data))
    })
    mock.triggerMessage(
      encodeBinaryMuxFrame({
        channel: BinaryMuxChannel.Terminal,
        messageType: TerminalBinaryMessageType.OutputUtf8,
        streamId: 23,
        offset: 0,
        payload: new TextEncoder().encode('before-exit'),
      })
    )
    expect(seen).toEqual(['before-exit'])
    expect(mock.sent).toHaveLength(1)
    mock.sent.length = 0

    mock.triggerMessage(
      wrapSessionMessage({
        type: 'terminal_stream_exit',
        payload: {
          streamId: 23,
          terminalId: 'term-1',
        },
      })
    )

    mock.triggerMessage(
      encodeBinaryMuxFrame({
        channel: BinaryMuxChannel.Terminal,
        messageType: TerminalBinaryMessageType.OutputUtf8,
        streamId: 23,
        offset: 12,
        payload: new TextEncoder().encode('after-exit'),
      })
    )

    expect(seen).toEqual(['before-exit'])
    expect(mock.sent).toHaveLength(1)
    const postExitAck = decodeBinaryMuxFrame(asUint8Array(mock.sent[0])!)
    expect(postExitAck?.messageType).toBe(TerminalBinaryMessageType.Ack)
    expect(postExitAck?.streamId).toBe(23)
    expect(postExitAck?.offset).toBe(22)
    unsubscribe()
  })

  test('cleans local stream state even when detach reports success=false', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const seen: string[] = []
    client.onTerminalStreamData(31, (chunk) => {
      seen.push(new TextDecoder().decode(chunk.data))
    })

    const detachPromise = client.detachTerminalStream(31, 'detach-31')
    const detachRequest = JSON.parse(String(mock.sent[0])) as {
      type: 'session'
      message: { type: string; streamId: number; requestId: string }
    }
    expect(detachRequest.message.type).toBe('detach_terminal_stream_request')
    expect(detachRequest.message.streamId).toBe(31)

    mock.triggerMessage(
      wrapSessionMessage({
        type: 'detach_terminal_stream_response',
        payload: {
          streamId: 31,
          success: false,
          requestId: 'detach-31',
        },
      })
    )

    const payload = await detachPromise
    expect(payload.success).toBe(false)

    mock.sent.length = 0
    mock.triggerMessage(
      encodeBinaryMuxFrame({
        channel: BinaryMuxChannel.Terminal,
        messageType: TerminalBinaryMessageType.OutputUtf8,
        streamId: 31,
        offset: 0,
        payload: new TextEncoder().encode('after-detach'),
      })
    )

    expect(seen).toEqual([])
    expect(mock.sent).toHaveLength(1)
    const detachedAck = decodeBinaryMuxFrame(asUint8Array(mock.sent[0])!)
    expect(detachedAck?.messageType).toBe(TerminalBinaryMessageType.Ack)
    expect(detachedAck?.streamId).toBe(31)
    expect(detachedAck?.offset).toBe(12)
  })

  test('parses canonical agent_stream tool_call payloads without crashing', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const received: unknown[] = []
    const unsubscribe = client.on('agent_stream', (msg) => {
      received.push(msg)
    })

    mock.triggerMessage(
      wrapSessionMessage({
        type: 'agent_stream',
        payload: {
          agentId: 'agent_cli',
          timestamp: '2026-02-08T20:20:00.000Z',
          event: {
            type: 'timeline',
            provider: 'codex',
            item: {
              type: 'tool_call',
              callId: 'call_cli_stream',
              name: 'shell',
              status: 'running',
              detail: {
                type: 'shell',
                command: 'pwd',
              },
              error: null,
            },
          },
        },
      })
    )

    unsubscribe()

    expect(received).toHaveLength(1)
    const streamMsg = received[0] as {
      payload: {
        event: {
          type: 'timeline'
          item: {
            type: 'tool_call'
            status: string
            error: unknown
            detail: {
              type: string
            }
          }
        }
      }
    }

    expect(streamMsg.payload.event.item.status).toBe('running')
    expect(streamMsg.payload.event.item.error).toBeNull()
    expect(streamMsg.payload.event.item.detail.type).toBe('shell')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  test('drops legacy agent_stream tool_call payloads and logs validation warning', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const received: unknown[] = []
    const unsubscribe = client.on('agent_stream', (msg) => {
      received.push(msg)
    })

    mock.triggerMessage(
      wrapSessionMessage({
        type: 'agent_stream',
        payload: {
          agentId: 'agent_cli',
          timestamp: '2026-02-08T20:20:00.000Z',
          event: {
            type: 'timeline',
            provider: 'codex',
            item: {
              type: 'tool_call',
              callId: 'call_cli_stream_legacy',
              name: 'shell',
              status: 'inProgress',
              detail: {
                type: 'unknown',
                input: { command: 'pwd' },
                output: null,
              },
            },
          },
        },
      })
    )

    unsubscribe()

    expect(received).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalled()
  })

  test('parses canonical fetch_agent_timeline_response payloads without crashing', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const received: unknown[] = []
    const unsubscribe = client.on('fetch_agent_timeline_response', (msg) => {
      received.push(msg)
    })

    mock.triggerMessage(
      wrapSessionMessage({
        type: 'fetch_agent_timeline_response',
        payload: {
          requestId: 'req-1',
          agentId: 'agent_cli',
          direction: 'tail',
          projection: 'projected',
          epoch: 'epoch-1',
          reset: false,
          staleCursor: false,
          gap: false,
          window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
          startCursor: { epoch: 'epoch-1', seq: 1 },
          endCursor: { epoch: 'epoch-1', seq: 1 },
          hasOlder: false,
          hasNewer: false,
          entries: [
            {
              timestamp: '2026-02-08T20:20:00.000Z',
              provider: 'codex',
              seqStart: 1,
              seqEnd: 1,
              sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
              collapsed: [],
              item: {
                type: 'tool_call',
                callId: 'call_cli_snapshot',
                name: 'shell',
                status: 'running',
                detail: {
                  type: 'shell',
                  command: 'pwd',
                },
                error: null,
              },
            },
          ],
          error: null,
        },
      })
    )

    unsubscribe()

    expect(received).toHaveLength(1)
    const timelineMsg = received[0] as {
      payload: {
        entries: Array<{
          item: {
            type: 'tool_call'
            status: string
            error: unknown
            detail: {
              type: string
            }
          }
        }>
      }
    }

    const firstEntry = timelineMsg.payload.entries[0]
    expect(firstEntry?.item.type).toBe('tool_call')
    if (firstEntry?.item.type === 'tool_call') {
      expect(firstEntry.item.status).toBe('running')
      expect(firstEntry.item.error).toBeNull()
      expect(firstEntry.item.detail.type).toBe('shell')
    }
    expect(logger.warn).not.toHaveBeenCalled()
  })

  test('drops invalid fetch_agent_timeline_response tool_call payloads and logs validation warning', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const received: unknown[] = []
    const unsubscribe = client.on('fetch_agent_timeline_response', (msg) => {
      received.push(msg)
    })

    mock.triggerMessage(
      wrapSessionMessage({
        type: 'fetch_agent_timeline_response',
        payload: {
          requestId: 'req-invalid',
          agentId: 'agent_cli',
          direction: 'tail',
          projection: 'projected',
          epoch: 'epoch-1',
          reset: false,
          staleCursor: false,
          gap: false,
          window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
          startCursor: { epoch: 'epoch-1', seq: 1 },
          endCursor: { epoch: 'epoch-1', seq: 1 },
          hasOlder: false,
          hasNewer: false,
          entries: [
            {
              timestamp: '2026-02-08T20:20:00.000Z',
              provider: 'codex',
              seqStart: 1,
              seqEnd: 1,
              sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
              collapsed: [],
              item: {
                type: 'tool_call',
                callId: 'call_cli_invalid',
                name: 'shell',
                status: 'inProgress',
                detail: {
                  type: 'unknown',
                  input: { command: 'pwd' },
                  output: null,
                },
              },
            },
          ],
          error: null,
        },
      })
    )

    unsubscribe()

    expect(received).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalled()
  })

  test('sends subscribe/unsubscribe terminals messages', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    client.subscribeTerminals({ cwd: '/tmp/project' })
    client.unsubscribeTerminals({ cwd: '/tmp/project' })

    expect(mock.sent).toHaveLength(2)
    expect(JSON.parse(String(mock.sent[0]))).toEqual({
      type: 'session',
      message: {
        type: 'subscribe_terminals_request',
        cwd: '/tmp/project',
      },
    })
    expect(JSON.parse(String(mock.sent[1]))).toEqual({
      type: 'session',
      message: {
        type: 'unsubscribe_terminals_request',
        cwd: '/tmp/project',
      },
    })
  })

  test('dispatches terminals_changed events to typed listeners', async () => {
    const logger = createMockLogger()
    const mock = createMockTransport()

    const client = new DaemonClient({
      url: 'ws://test',
      clientId: 'clsk_unit_test',
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    })
    clients.push(client)

    const connectPromise = client.connect()
    mock.triggerOpen()
    await connectPromise

    const received: Array<{ cwd: string; names: string[] }> = []
    const unsubscribe = client.on('terminals_changed', (message) => {
      received.push({
        cwd: message.payload.cwd,
        names: message.payload.terminals.map((terminal) => terminal.name),
      })
    })

    mock.triggerMessage(
      wrapSessionMessage({
        type: 'terminals_changed',
        payload: {
          cwd: '/tmp/project',
          terminals: [
            {
              id: 'term-1',
              name: 'Dev Server',
            },
          ],
        },
      })
    )

    unsubscribe()

    expect(received).toEqual([
      {
        cwd: '/tmp/project',
        names: ['Dev Server'],
      },
    ])
  })

  test('waitForFinish with timeout=0 omits timeoutMs and has no client deadline', async () => {
    vi.useFakeTimers()
    try {
      const logger = createMockLogger()
      const mock = createMockTransport()

      const client = new DaemonClient({
        url: 'ws://test',
        clientId: 'clsk_unit_test',
        logger,
        reconnect: { enabled: false },
        transportFactory: () => mock.transport,
      })
      clients.push(client)

      const connectPromise = client.connect()
      mock.triggerOpen()
      await connectPromise

      const waitPromise = client.waitForFinish('agent-wait-zero-timeout', 0)

      expect(mock.sent).toHaveLength(1)
      const request = JSON.parse(String(mock.sent[0])) as {
        type: 'session'
        message: {
          type: 'wait_for_finish_request'
          requestId: string
          agentId: string
          timeoutMs?: number
        }
      }
      expect(request.message.type).toBe('wait_for_finish_request')
      expect(request.message.agentId).toBe('agent-wait-zero-timeout')
      expect(request.message).not.toHaveProperty('timeoutMs')

      const settled = vi.fn()
      void waitPromise.then(
        () => settled('resolved'),
        () => settled('rejected')
      )

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      expect(settled).not.toHaveBeenCalled()

      mock.triggerMessage(
        wrapSessionMessage({
          type: 'wait_for_finish_response',
          payload: {
            requestId: request.message.requestId,
            status: 'idle',
            final: null,
            error: null,
            lastMessage: null,
          },
        })
      )

      await expect(waitPromise).resolves.toEqual({
        status: 'idle',
        final: null,
        error: null,
        lastMessage: null,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
