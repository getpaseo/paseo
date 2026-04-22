# Attachment-Based Review Context Plan

## Goal

Use structured attachments as the source of truth for review context during agent creation.

This covers two related behaviors:

1. Provider-facing context for the agent prompt
2. Worktree checkout behavior when creating a worktree from a review item

The design should stay compatible with future forge support such as GitLab.

## Core Direction

- Do not parse the prompt to discover issue/PR intent.
- Do not introduce deeply nested transport objects for this flow.
- Make the attachment itself the discriminated union.
- Keep forge-specific checkout logic below the attachment layer.
- Let each agent provider translate attachments into its own prompt/input format.

## Initial Attachment Types

Two initial structured attachment types:

- `github_pr`
- `github_issue`

With separate MIME types:

- `application/github-pr`
- `application/github-issue`

Proposed wire shape:

```ts
type AgentAttachment =
  | {
      type: "github_pr";
      mimeType: "application/github-pr";
      number: number;
      title: string;
      url: string;
      body?: string | null;
      baseRefName?: string | null;
      headRefName?: string | null;
    }
  | {
      type: "github_issue";
      mimeType: "application/github-issue";
      number: number;
      title: string;
      url: string;
      body?: string | null;
    };
```

## Backward Compatibility

- Add new optional `attachments` fields; keep existing `images` fields.
- Unknown attachment discriminators must be dropped during schema normalization instead of failing the full request.
- Malformed attachment entries should also be ignored safely.
- Old clients continue working because `attachments` is optional.
- New clients can send `attachments` without breaking older flows that still rely on `images`.

## Request-Level Changes

Add optional `attachments` to:

- `create_agent_request`
- `send_agent_message_request`

Existing `initialPrompt` remains plain user text.

The selected GitHub PR/issue becomes a structured attachment instead of being injected into prompt text as the primary source of truth.

## App Responsibilities

When the user selects a GitHub item:

- If it is a PR, create a `github_pr` attachment
- If it is an issue, create a `github_issue` attachment
- Include the attachment in the create-agent request

The UI can still render friendly labels and previews from the same data.

The app should stop treating PR/issue context as prompt-only metadata.

## Worktree Creation Behavior

During agent creation, if worktree creation is requested:

- Inspect normalized attachments
- If a `github_pr` attachment is present, use it to drive checkout for the worktree

The important rule:

- attachment type identifies the review object
- server-side git logic decides how to check it out

This keeps the attachment contract simple while allowing fork-safe implementation details.

## Checkout Resolution

The attachment itself should not encode the full checkout strategy.

Instead, the server should resolve checkout from the `github_pr` attachment using forge-aware logic.

Examples of possible implementation strategies:

- `gh pr checkout`
- `git fetch origin refs/pull/<number>/head:<local-branch>`
- another GitHub-aware resolver if needed later

This is intentionally a server implementation detail, not part of the attachment schema.

## Provider Responsibilities

Each provider adapter should receive normalized attachments and decide how to represent them for the model.

Examples:

- Claude: render attachment into text blocks
- Codex: inject as blocks or text
- OpenCode: send as file/resource-like input where appropriate
- ACP: convert to resource/text forms as supported

The session layer should not hardcode one translation strategy for all providers.

## Suggested Implementation Order

1. Add tolerant attachment schema and normalization in shared/server message handling.
2. Thread `attachments` through app -> daemon client -> session layer.
3. Update create-agent UI flows to emit `github_pr` / `github_issue` attachments from GitHub selection.
4. Teach worktree creation to inspect attachments and special-case `github_pr`.
5. Update provider adapters to translate attachments into provider-specific prompt/input forms.
6. Optionally migrate image transport into the same attachment mechanism later.

## Files Likely Involved

- `packages/server/src/shared/messages.ts`
- `packages/server/src/client/daemon-client.ts`
- `packages/server/src/server/session.ts`
- `packages/server/src/server/worktree-session.ts`
- `packages/server/src/server/agent/agent-sdk-types.ts`
- `packages/server/src/server/agent/providers/claude-agent.ts`
- `packages/server/src/server/agent/providers/codex-app-server-agent.ts`
- `packages/server/src/server/agent/providers/opencode-agent.ts`
- `packages/server/src/server/agent/providers/acp-agent.ts`
- `packages/app/src/screens/new-workspace-screen.tsx`
- `packages/app/src/screens/agent/draft-agent-screen.tsx`
- `packages/app/src/contexts/session-context.tsx`

## Notes

- The current image path can remain in place initially.
- The plan intentionally keeps checkout concerns separate from provider prompt translation.
- Future forge support should add new attachment discriminators rather than expanding GitHub-only nested fields.
