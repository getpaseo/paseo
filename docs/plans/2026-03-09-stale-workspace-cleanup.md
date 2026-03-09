# Stale Workspace Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect stale worktrees (whose `cwd` no longer exists on disk) and let users archive them from the sidebar.

**Architecture:** Server checks `fs.access(cwd)` during workspace descriptor listing and adds a `stale` boolean to the wire payload. The app shows a minimal visual indicator and routes stale worktree archives through the regular archive path (since the worktree-specific path fails when the directory is gone).

**Tech Stack:** Node.js (server), React Native/Expo (app), Zod (schema validation), Vitest (tests)

---

### Task 1: Add `stale` field to `WorkspaceDescriptorPayload` schema

**Files:**
- Modify: `packages/server/src/shared/messages.ts:1483-1497`

**Step 1: Add `stale` to the Zod schema**

In `WorkspaceDescriptorPayloadSchema`, add `stale: z.boolean().optional()` after `diffStat`:

```typescript
export const WorkspaceDescriptorPayloadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectDisplayName: z.string(),
  projectRootPath: z.string(),
  projectKind: z.enum(['git', 'non_git']),
  workspaceKind: z.enum(['local_checkout', 'worktree', 'directory']),
  name: z.string(),
  status: WorkspaceStateBucketSchema,
  activityAt: z.string().nullable(),
  diffStat: z.object({
    additions: z.number(),
    deletions: z.number(),
  }).nullable().optional(),
  stale: z.boolean().optional(),
})
```

**Step 2: Run typecheck**

Run: `cd packages/server && npx tsc --noEmit`
Expected: PASS (optional field, no breakage)

**Step 3: Commit**

```
feat: add stale field to WorkspaceDescriptorPayload schema
```

---

### Task 2: Server — detect stale workspaces in `listWorkspaceDescriptors`

**Files:**
- Modify: `packages/server/src/server/session.ts:5241-5319`

**Step 1: Add fs.access check in `describeWorkspaceRecord`**

After the existing `diffStat` try/catch block (around line 5262), add a stale check:

```typescript
let stale = false
try {
  await fs.access(workspace.cwd)
} catch {
  stale = true
}
```

Then include `stale` in the returned object (only when true, to keep payloads lean):

```typescript
return {
  id: workspace.workspaceId,
  projectId: workspace.projectId,
  projectDisplayName: resolvedProjectRecord?.displayName ?? workspace.projectId,
  projectRootPath: resolvedProjectRecord?.rootPath ?? workspace.cwd,
  projectKind: resolvedProjectRecord?.kind ?? 'non_git',
  workspaceKind: workspace.kind,
  name: displayName,
  status: 'done',
  activityAt: null,
  diffStat,
  ...(stale ? { stale: true } : {}),
}
```

Make sure `fs` (from `node:fs/promises` or the existing `promises as fs` import) is available at the top of the file.

**Step 2: Run typecheck**

Run: `cd packages/server && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```
feat: detect stale workspaces by checking if cwd exists on disk
```

---

### Task 3: Server — allow archiving stale worktrees via `archive_workspace_request`

**Files:**
- Modify: `packages/server/src/server/session.ts:5857-5896`

**Step 1: Modify `handleArchiveWorkspaceRequest`**

Change the worktree rejection (line 5865-5866) to only reject when the cwd still exists:

```typescript
if (existing.kind === 'worktree') {
  try {
    await fs.access(existing.cwd)
    // Directory still exists — use the full worktree archive flow
    throw new Error('Use worktree archive for Paseo worktrees')
  } catch (accessError) {
    if ((accessError as Error).message === 'Use worktree archive for Paseo worktrees') {
      throw accessError
    }
    // Directory is gone — allow archiving via the simple path
  }
}
```

**Step 2: Run typecheck**

Run: `cd packages/server && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```
fix: allow archiving stale worktrees whose directory no longer exists
```

---

### Task 4: Write server-side tests for stale detection and archive

**Files:**
- Modify: `packages/server/src/server/session.workspaces.test.ts`

**Step 1: Write test for stale detection**

Add a test that creates a workspace with a cwd that doesn't exist and verifies `stale: true` is in the descriptor:

```typescript
test('workspace with missing cwd is marked as stale', async () => {
  const session = createSessionForWorkspaceTests() as any
  session.workspaceRegistry.list = async () => [
    createPersistedWorkspaceRecord({
      workspaceId: '/tmp/does-not-exist-workspace',
      projectId: '/tmp/does-not-exist-workspace',
      cwd: '/tmp/does-not-exist-workspace',
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
```

**Step 2: Write test for non-stale workspace**

```typescript
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
```

**Step 3: Write test for archiving stale worktree**

```typescript
test('archive_workspace_request succeeds for stale worktree', async () => {
  const emitted: Array<{ type: string; payload: unknown }> = []
  const session = createSessionForWorkspaceTests() as any
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: '/tmp/gone-worktree',
    projectId: '/tmp/gone-worktree',
    cwd: '/tmp/gone-worktree',
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
    workspaceId: '/tmp/gone-worktree',
    requestId: 'req-archive-stale',
  })

  expect(workspace.archivedAt).toBeTruthy()
  const response = emitted.find((message) => message.type === 'archive_workspace_response') as any
  expect(response?.payload.error).toBeNull()
})
```

**Step 4: Run tests**

Run: `cd packages/server && npx vitest run src/server/session.workspaces.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```
test: add tests for stale workspace detection and archive
```

---

### Task 5: App — add `stale` to client-side types and pass through

**Files:**
- Modify: `packages/app/src/stores/session-store.ts:113-143`
- Modify: `packages/app/src/hooks/use-sidebar-workspaces-list.ts:13-22,125-134`

**Step 1: Add `stale` to `WorkspaceDescriptor` interface**

```typescript
export interface WorkspaceDescriptor {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  projectKind: WorkspaceDescriptorPayload["projectKind"];
  workspaceKind: WorkspaceDescriptorPayload["workspaceKind"];
  name: string;
  status: WorkspaceDescriptorPayload["status"];
  activityAt: Date | null;
  diffStat: { additions: number; deletions: number } | null;
  stale: boolean;
}
```

**Step 2: Update `normalizeWorkspaceDescriptor` to include `stale`**

```typescript
return {
  ...existing fields...,
  stale: payload.stale ?? false,
};
```

**Step 3: Add `stale` to `SidebarWorkspaceEntry` interface and `buildSidebarProjectsFromWorkspaces`**

In `use-sidebar-workspaces-list.ts`, add `stale: boolean` to `SidebarWorkspaceEntry` and set it in the row builder:

```typescript
const row: SidebarWorkspaceEntry = {
  ...existing fields...,
  stale: workspace.stale,
}
```

**Step 4: Run typecheck**

Run: `cd packages/app && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```
feat: pass stale workspace flag through to sidebar entries
```

---

### Task 6: App — show stale indicator in sidebar and fix archive routing

**Files:**
- Modify: `packages/app/src/components/sidebar-workspace-list.tsx`

**Step 1: Show stale indicator in `WorkspaceRowInner`**

After the workspace name `<Text>` (around line 662-664), add a stale label when the workspace is stale:

```tsx
<Text style={styles.workspaceBranchText} numberOfLines={1}>
  {workspace.name}
</Text>
{workspace.stale ? (
  <Text style={styles.workspaceStaleLabel} numberOfLines={1}>
    missing
  </Text>
) : null}
```

Add the style:

```typescript
workspaceStaleLabel: {
  fontSize: 10,
  color: theme.colors.warning ?? theme.colors.foregroundMuted,
  marginLeft: 4,
  opacity: 0.8,
},
```

**Step 2: Route stale worktree archives through regular archive path**

In `WorkspaceRowWithMenu`, change the archive handler selection. When `isWorktree && workspace.stale`, use `handleArchiveWorkspace` instead of `handleArchiveWorktree`:

```typescript
const isStaleWorktree = isWorktree && workspace.stale
// ...
onArchive={isWorktree && !isStaleWorktree ? handleArchiveWorktree : handleArchiveWorkspace}
archiveLabel={isWorktree && !isStaleWorktree ? 'Archive worktree' : isStaleWorktree ? 'Remove stale worktree' : 'Hide from sidebar'}
```

**Step 3: Run typecheck**

Run: `cd packages/app && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```
feat: show stale indicator in sidebar and fix archive for stale worktrees
```

---

### Task 7: Final verification

**Step 1: Run all server tests**

Run: `cd packages/server && npx vitest run src/server/session.workspaces.test.ts`
Expected: ALL PASS

**Step 2: Run full typecheck for both packages**

Run: `cd packages/server && npx tsc --noEmit && cd ../app && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit any remaining fixes**
