# Workspace row badges

Install this directory as a plugin. Any workspace that needs input or has failed shows a badge on
the line under its title in the sidebar. Workspaces in any other state show nothing.

The component reads its own data with `useWorkspace(workspaceId, selector)` and returns `null` when
it has nothing to say. **Show → Workspace attention** in the sidebar's display preferences toggles it.

See the [reference](../../public-docs/plugins/reference.md#workspace-row-badge-items).
