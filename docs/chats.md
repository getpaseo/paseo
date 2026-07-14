# Chat workspaces

A **chat** is a temporary workspace designed purely to chat with an LLM without modifying user projects or editing the local file system. Chats do not have a permanent workspace or git repository; instead, the daemon mints a temporary scratch directory under `$PASEO_HOME/chats/chat-<hex>` on the first request. The agent runs in this directory, and the workspace is grouped under the synthetic "Chats" project in the UI until it is archived and cleared by the daemon.

## Creating a chat

`create_agent_request` carries an optional `chatWorkspace: true` flag. When set:

1. Client sends the flag (gated by `server_info.features.chatWorkspace` — old daemons don't advertise it)
2. Daemon mints a fresh scratch directory at `$PASEO_HOME/chats/chat-<hex>`
3. Daemon creates a workspace record with `projectKind: non_git`, `workspaceKind: directory`, and `cwd` pointing to the scratch dir
4. The `WorkspaceDescriptorPayload.chatWorkspace` flag marks the record. Clients key sidebar placement off this flag, not the synthetic project name: chat workspaces are pulled out of the normal per-project grouping and rendered in a dedicated "Chats" section below Workspaces (`splitSidebarChatWorkspaces` in `packages/app/src/hooks/sidebar-workspaces-view-model.ts`); the synthetic "Chats" project header never renders

No isolation choice and no git state — the workspace is a plain directory, created purely for this conversation.

## Auto-titling

The workspace title is initially derived from the first message prompt (clamped to 60 characters), then updates in the background when the workspace name generator runs.

## Archive

Archiving a chat workspace deletes its scratch directory (including all agent history within it), best-effort — a locked file on Windows logs a warning and leaves the directory behind, but the archive itself still succeeds. This applies to every archive path, including removing the whole Chats project. The workspace record is soft-deleted (marked `archivedAt`) like any other workspace.

## Feature gating

The feature is gated by `server_info.features.chatWorkspace`. Old daemons (v0.1.106 without this flag) do not support chats. Clients hide the "Just chat" entry point, the "New chat" sidebar action, and the "New chat" home-screen tile (all route to `/new?chat=1`) — and disallow creating chats when the feature is absent.

// COMPAT(chatWorkspace): added in v0.1.106, drop the gate when floor >= v0.1.106
