import { describe, expect, it } from 'vitest'
import { buildSidebarProjectRowModel } from './sidebar-project-row-model'
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from '@/hooks/use-sidebar-workspaces-list'

function workspace(overrides: Partial<SidebarWorkspaceEntry> = {}): SidebarWorkspaceEntry {
  return {
    workspaceKey: 'srv:/repo',
    serverId: 'srv',
    workspaceId: '/repo',
    workspaceKind: 'directory',
    name: 'paseo',
    activityAt: null,
    statusBucket: 'done',
    diffStat: null,
    stale: false,
    ...overrides,
  }
}

function project(overrides: Partial<SidebarProjectEntry> = {}): SidebarProjectEntry {
  return {
    projectKey: 'project-1',
    projectName: 'paseo',
    projectKind: 'git',
    iconWorkingDir: '/repo',
    statusBucket: 'done',
    activeCount: 0,
    totalWorkspaces: 1,
    latestActivityAt: null,
    workspaces: [workspace()],
    ...overrides,
  }
}

describe('buildSidebarProjectRowModel', () => {
  it('flattens non-git projects with one workspace into a direct workspace row model', () => {
    const flattenedWorkspace = workspace({
      workspaceId: '/repo/non-git',
      workspaceKind: 'directory',
      statusBucket: 'running',
    })

    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: 'non_git',
        workspaces: [flattenedWorkspace],
      }),
      collapsed: false,
    })

    expect(result).toEqual({
      interaction: 'navigate',
      chevron: 'disclosure',
      trailingAction: 'none',
      flattenedWorkspace,
      selected: false,
    })
  })

  it('marks flattened non-git project rows as selected when their workspace is active', () => {
    const flattenedWorkspace = workspace({
      serverId: 'srv-2',
      workspaceId: '/repo/non-git',
    })

    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: 'non_git',
        workspaces: [flattenedWorkspace],
      }),
      collapsed: false,
      serverId: 'srv-2',
      activeWorkspaceSelection: {
        serverId: 'srv-2',
        workspaceId: '/repo/non-git',
      },
    })

    expect(result.selected).toBe(true)
  })

  it('keeps git projects as expandable sections with a new worktree action', () => {
    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: 'git',
        workspaces: [
          workspace({ workspaceId: '/repo/main', workspaceKind: 'local_checkout' }),
          workspace({ workspaceId: '/repo/feature', workspaceKind: 'worktree' }),
        ],
      }),
      collapsed: true,
    })

    expect(result).toEqual({
      interaction: 'toggle',
      chevron: 'expand',
      trailingAction: 'new_worktree',
      flattenedWorkspace: null,
      selected: false,
    })
  })
})
