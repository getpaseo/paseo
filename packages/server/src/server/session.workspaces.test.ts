import { describe, expect, test, vi } from 'vitest'
import { Session } from './session.js'
import type { AgentSnapshotPayload } from '../shared/messages.js'
import { createPersistedProjectRecord, createPersistedWorkspaceRecord } from './workspace-registry.js'

function makeAgent(input: {
  id: string
  cwd: string
  status: AgentSnapshotPayload['status']
  updatedAt: string
  pendingPermissions?: number
  requiresAttention?: boolean
  attentionReason?: AgentSnapshotPayload['attentionReason']
}): AgentSnapshotPayload {
  const pendingPermissionCount = input.pendingPermissions ?? 0
  return {
    id: input.id,
    provider: 'codex',
    cwd: input.cwd,
    model: null,
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    lastUserMessageAt: null,
    status: input.status,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: Array.from({ length: pendingPermissionCount }, (_, index) => ({
      id: `perm-${input.id}-${index}`,
      provider: 'codex',
      name: 'tool',
      kind: 'tool',
    })),
    persistence: null,
    runtimeInfo: {
      provider: 'codex',
      sessionId: null,
    },
    title: null,
    labels: {},
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: null,
    archivedAt: null,
  }
}

function createSessionForWorkspaceTests(): Session {
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  return new Session({
    clientId: 'test-client',
    onMessage: vi.fn(),
    logger: logger as any,
    downloadTokenStore: {} as any,
    pushTokenStore: {} as any,
    paseoHome: '/tmp/paseo-test',
    agentManager: {
      subscribe: () => () => {},
      listAgents: () => [],
      getAgent: () => null,
    } as any,
    agentStorage: {
      list: async () => [],
      get: async () => null,
    } as any,
    projectRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
      upsert: async () => {},
      archive: async () => {},
      remove: async () => {},
    } as any,
    workspaceRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
      upsert: async () => {},
      archive: async () => {},
      remove: async () => {},
    } as any,
    createAgentMcpTransport: async () => {
      throw new Error('not used')
    },
    stt: null,
    tts: null,
    terminalManager: null,
  })
}

describe('workspace aggregation', () => {
  test('non-git workspace uses deterministic directory name and no unknown branch fallback', async () => {
    const session = createSessionForWorkspaceTests() as any
    session.workspaceRegistry.list = async () => [
      createPersistedWorkspaceRecord({
        workspaceId: '/tmp/non-git',
        projectId: '/tmp/non-git',
        cwd: '/tmp/non-git',
        kind: 'directory',
        displayName: 'non-git',
        createdAt: '2026-03-01T12:00:00.000Z',
        updatedAt: '2026-03-01T12:00:00.000Z',
      }),
    ]
    session.listAgentPayloads = async () => [
      makeAgent({
        id: 'a1',
        cwd: '/tmp/non-git',
        status: 'idle',
        updatedAt: '2026-03-01T12:00:00.000Z',
      }),
    ]
    const result = await session.listFetchWorkspacesEntries({
      type: 'fetch_workspaces_request',
      requestId: 'req-1',
    })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.name).toBe('non-git')
    expect(result.entries[0]?.name).not.toBe('Unknown branch')
  })

  test('git branch workspace uses branch as canonical name', async () => {
    const session = createSessionForWorkspaceTests() as any
    session.workspaceRegistry.list = async () => [
      createPersistedWorkspaceRecord({
        workspaceId: '/tmp/repo-branch',
        projectId: '/tmp/repo-branch',
        cwd: '/tmp/repo-branch',
        kind: 'local_checkout',
        displayName: 'feature/name-from-server',
        createdAt: '2026-03-01T12:00:00.000Z',
        updatedAt: '2026-03-01T12:00:00.000Z',
      }),
    ]
    session.listAgentPayloads = async () => [
      makeAgent({
        id: 'a1',
        cwd: '/tmp/repo-branch',
        status: 'running',
        updatedAt: '2026-03-01T12:00:00.000Z',
      }),
    ]
    session.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: 'repo-branch',
      checkout: {
        cwd,
        isGit: true,
        currentBranch: 'feature/name-from-server',
        remoteUrl: 'https://github.com/acme/repo-branch.git',
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    })
    const result = await session.listFetchWorkspacesEntries({
      type: 'fetch_workspaces_request',
      requestId: 'req-branch',
    })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.name).toBe('feature/name-from-server')
  })

  test('branch/detached policies and dominant status bucket are deterministic', async () => {
    const session = createSessionForWorkspaceTests() as any
    session.workspaceRegistry.list = async () => [
      createPersistedWorkspaceRecord({
        workspaceId: '/tmp/repo',
        projectId: '/tmp/repo',
        cwd: '/tmp/repo',
        kind: 'local_checkout',
        displayName: 'repo',
        createdAt: '2026-03-01T12:00:00.000Z',
        updatedAt: '2026-03-01T12:00:00.000Z',
      }),
    ]
    session.listAgentPayloads = async () => [
      makeAgent({
        id: 'a1',
        cwd: '/tmp/repo',
        status: 'running',
        updatedAt: '2026-03-01T12:00:00.000Z',
      }),
      makeAgent({
        id: 'a2',
        cwd: '/tmp/repo',
        status: 'error',
        updatedAt: '2026-03-01T12:01:00.000Z',
      }),
      makeAgent({
        id: 'a3',
        cwd: '/tmp/repo',
        status: 'idle',
        updatedAt: '2026-03-01T12:02:00.000Z',
        pendingPermissions: 1,
      }),
    ]
    const result = await session.listFetchWorkspacesEntries({
      type: 'fetch_workspaces_request',
      requestId: 'req-2',
    })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.name).toBe('repo')
    expect(result.entries[0]?.status).toBe('needs_input')
  })

  test('workspace update stream keeps persisted workspace visible after agents stop', async () => {
    const emitted: Array<{ type: string; payload: unknown }> = []
    const logger = {
      child: () => logger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    const session = new Session({
      clientId: 'test-client',
      onMessage: (message) => emitted.push(message as any),
      logger: logger as any,
      downloadTokenStore: {} as any,
      pushTokenStore: {} as any,
      paseoHome: '/tmp/paseo-test',
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: () => null,
      } as any,
      agentStorage: {
        list: async () => [],
        get: async () => null,
      } as any,
      projectRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      workspaceRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      createAgentMcpTransport: async () => {
        throw new Error('not used')
      },
      stt: null,
      tts: null,
      terminalManager: null,
    }) as any

    session.workspaceUpdatesSubscription = {
      subscriptionId: 'sub-1',
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
    }

    session.listWorkspaceDescriptors = async () => [
      {
        id: '/tmp/repo',
        projectId: '/tmp/repo',
        projectDisplayName: 'repo',
        projectRootPath: '/tmp/repo',
        projectKind: 'non_git',
        workspaceKind: 'directory',
        name: 'repo',
        status: 'running',
        activityAt: '2026-03-01T12:00:00.000Z',
      },
    ]
    await session.emitWorkspaceUpdateForCwd('/tmp/repo')

    session.listWorkspaceDescriptors = async () => [
      {
        id: '/tmp/repo',
        projectId: '/tmp/repo',
        projectDisplayName: 'repo',
        projectRootPath: '/tmp/repo',
        projectKind: 'non_git',
        workspaceKind: 'directory',
        name: 'repo',
        status: 'done',
        activityAt: null,
      },
    ]
    await session.emitWorkspaceUpdateForCwd('/tmp/repo')

    const workspaceUpdates = emitted.filter((message) => message.type === 'workspace_update')
    expect(workspaceUpdates).toHaveLength(2)
    expect((workspaceUpdates[0] as any).payload.kind).toBe('upsert')
    expect((workspaceUpdates[1] as any).payload).toEqual({
      kind: 'upsert',
      workspace: {
        id: '/tmp/repo',
        projectId: '/tmp/repo',
        projectDisplayName: 'repo',
        projectRootPath: '/tmp/repo',
        projectKind: 'non_git',
        workspaceKind: 'directory',
        name: 'repo',
        status: 'done',
        activityAt: null,
      },
    })
  })

  test('workspace update fanout for multiple cwd values is deduplicated', async () => {
    const session = createSessionForWorkspaceTests() as any
    session.workspaceUpdatesSubscription = {
      subscriptionId: 'sub-dedupe',
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
    }

    const emitWorkspaceUpdateForCwd = vi.fn(async () => {})
    session.emitWorkspaceUpdateForCwd = emitWorkspaceUpdateForCwd

    await session.emitWorkspaceUpdatesForCwds([
      '/tmp/repo',
      '/tmp/repo/',
      '  /tmp/repo  ',
      '/tmp/repo/sub',
      '/tmp/repo/sub/',
    ])

    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledTimes(2)
    expect(emitWorkspaceUpdateForCwd).toHaveBeenNthCalledWith(1, '/tmp/repo')
    expect(emitWorkspaceUpdateForCwd).toHaveBeenNthCalledWith(2, '/tmp/repo/sub')
  })

  test('open_project_request registers a workspace before any agent exists', async () => {
    const emitted: Array<{ type: string; payload: unknown }> = []
    const session = createSessionForWorkspaceTests() as any
    const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>()
    const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>()

    session.emit = (message: any) => emitted.push(message)
    session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null
    session.projectRegistry.upsert = async (record: ReturnType<typeof createPersistedProjectRecord>) => {
      projects.set(record.projectId, record)
    }
    session.workspaceRegistry.get = async (workspaceId: string) => workspaces.get(workspaceId) ?? null
    session.workspaceRegistry.upsert = async (
      record: ReturnType<typeof createPersistedWorkspaceRecord>
    ) => {
      workspaces.set(record.workspaceId, record)
    }
    session.projectRegistry.list = async () => Array.from(projects.values())
    session.workspaceRegistry.list = async () => Array.from(workspaces.values())
    session.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: 'repo',
      checkout: {
        cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    })

    await session.handleMessage({
      type: 'open_project_request',
      cwd: '/tmp/repo',
      requestId: 'req-open',
    })

    expect(workspaces.get('/tmp/repo')).toBeTruthy()
    const response = emitted.find((message) => message.type === 'open_project_response') as any
    expect(response?.payload.error).toBeNull()
    expect(response?.payload.workspace?.id).toBe('/tmp/repo')
  })

  test('archive_workspace_request hides non-destructive workspace records', async () => {
    const emitted: Array<{ type: string; payload: unknown }> = []
    const session = createSessionForWorkspaceTests() as any
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: '/tmp/repo',
      projectId: '/tmp/repo',
      cwd: '/tmp/repo',
      kind: 'directory',
      displayName: 'repo',
      createdAt: '2026-03-01T12:00:00.000Z',
      updatedAt: '2026-03-01T12:00:00.000Z',
    })

    session.emit = (message: any) => emitted.push(message)
    session.workspaceRegistry.get = async () => workspace
    session.workspaceRegistry.archive = async (_workspaceId: string, archivedAt: string) => {
      workspace.archivedAt = archivedAt
    }
    session.workspaceRegistry.list = async () => [workspace]
    session.projectRegistry.archive = async () => {}

    await session.handleMessage({
      type: 'archive_workspace_request',
      workspaceId: '/tmp/repo',
      requestId: 'req-archive',
    })

    expect(workspace.archivedAt).toBeTruthy()
    const response = emitted.find((message) => message.type === 'archive_workspace_response') as any
    expect(response?.payload.error).toBeNull()
  })

  test('workspace with missing cwd is marked as stale', async () => {
    const session = createSessionForWorkspaceTests() as any
    session.workspaceRegistry.list = async () => [
      createPersistedWorkspaceRecord({
        workspaceId: '/tmp/does-not-exist-workspace-stale-test',
        projectId: '/tmp/does-not-exist-workspace-stale-test',
        cwd: '/tmp/does-not-exist-workspace-stale-test',
        kind: 'worktree',
        displayName: 'stale-branch',
        createdAt: '2026-03-01T12:00:00.000Z',
        updatedAt: '2026-03-01T12:00:00.000Z',
      }),
    ]
    session.listAgentPayloads = async () => []
    const result = await session.listFetchWorkspacesEntries({
      type: 'fetch_workspaces_request',
      requestId: 'req-stale',
    })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.stale).toBe(true)
  })

  test('workspace with existing cwd is not marked as stale', async () => {
    const session = createSessionForWorkspaceTests() as any
    session.workspaceRegistry.list = async () => [
      createPersistedWorkspaceRecord({
        workspaceId: '/tmp',
        projectId: '/tmp',
        cwd: '/tmp',
        kind: 'directory',
        displayName: 'tmp',
        createdAt: '2026-03-01T12:00:00.000Z',
        updatedAt: '2026-03-01T12:00:00.000Z',
      }),
    ]
    session.listAgentPayloads = async () => []
    const result = await session.listFetchWorkspacesEntries({
      type: 'fetch_workspaces_request',
      requestId: 'req-not-stale',
    })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.stale).toBeFalsy()
  })

  test('archive_workspace_request succeeds for stale worktree whose cwd is missing', async () => {
    const emitted: Array<{ type: string; payload: unknown }> = []
    const session = createSessionForWorkspaceTests() as any
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: '/tmp/gone-worktree-stale-test',
      projectId: '/tmp/gone-worktree-stale-test',
      cwd: '/tmp/gone-worktree-stale-test',
      kind: 'worktree',
      displayName: 'gone-branch',
      createdAt: '2026-03-01T12:00:00.000Z',
      updatedAt: '2026-03-01T12:00:00.000Z',
    })

    session.emit = (message: any) => emitted.push(message)
    session.workspaceRegistry.get = async () => workspace
    session.workspaceRegistry.archive = async (_workspaceId: string, archivedAt: string) => {
      workspace.archivedAt = archivedAt
    }
    session.workspaceRegistry.list = async () => [workspace]
    session.projectRegistry.archive = async () => {}

    await session.handleMessage({
      type: 'archive_workspace_request',
      workspaceId: '/tmp/gone-worktree-stale-test',
      requestId: 'req-archive-stale',
    })

    expect(workspace.archivedAt).toBeTruthy()
    const response = emitted.find((message) => message.type === 'archive_workspace_response') as any
    expect(response?.payload.error).toBeNull()
  })
})
