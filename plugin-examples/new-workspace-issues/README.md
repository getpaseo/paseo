# New workspace issues

Install this directory as a plugin and open New workspace. An **Issue** field appears beside the
project, host, and branch pickers: a field on a phone, a badge on desktop.

Choosing an issue:

- Calls `newWorkspace.setBranch(issue.branch)`, so a worktree is created on that branch name.
- Calls `newWorkspace.setMetadata({ "new-workspace-issues.issue": issue.id })`, so the created
  workspace carries the issue id.

`Combobox` runs `search` when the list opens and again as the user types. Paseo shows the loading
and error states and drops results that a newer search replaced. The server handler in
[server/issues.ts](server/issues.ts) filters a fixed list; a real plugin would call its tracker.

[client/issue-field.tsx](client/issue-field.tsx) is the field; [index.client.tsx](index.client.tsx)
registers it with `addNewWorkspaceItem`.
