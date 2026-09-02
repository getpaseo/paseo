import { beforeEach, describe, expect, it } from "vitest";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  type PendingWorkspaceDraftSubmission,
  useWorkspaceDraftSubmissionStore,
} from "./workspace-draft-submission-store";

function buildSubmission(
  overrides: Partial<PendingWorkspaceDraftSubmission> = {},
): PendingWorkspaceDraftSubmission {
  return {
    serverId: "server-1",
    workspaceId: "workspace-1",
    draftId: "draft-1",
    text: "hello",
    attachments: [],
    cwd: "/repo",
    provider: "claude" as AgentProvider,
    clientMessageId: "msg-1",
    timestamp: 1,
    ...overrides,
  };
}

describe("workspace-draft-submission-store", () => {
  beforeEach(() => {
    useWorkspaceDraftSubmissionStore.setState({ pendingByDraftId: {}, setupByDraftId: {} });
  });

  // This is the single cross-instance dedupe the create path relies on: the
  // first draft tab consumes the pending, the entry is removed, and every later
  // tab gets null so it does not create a second agent. Regression guard for
  // #3217, where a minifier miscompilation left the removal a no-op and produced
  // N duplicate agents.
  it("removes the pending on consume so a second consume returns null", () => {
    const store = useWorkspaceDraftSubmissionStore.getState();
    store.setPending(buildSubmission());

    const first = store.consumePending({
      serverId: "server-1",
      workspaceId: "workspace-1",
      draftId: "draft-1",
    });
    const second = store.consumePending({
      serverId: "server-1",
      workspaceId: "workspace-1",
      draftId: "draft-1",
    });

    expect(first).not.toBeNull();
    expect(first?.clientMessageId).toBe("msg-1");
    expect(second).toBeNull();
    // The entry must be gone — this is exactly what the miscompiled omit failed to do.
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).toEqual({});
  });

  it("only removes the consumed draft, leaving other pending submissions intact", () => {
    const store = useWorkspaceDraftSubmissionStore.getState();
    store.setPending(buildSubmission({ draftId: "draft-1", clientMessageId: "msg-1" }));
    store.setPending(buildSubmission({ draftId: "draft-2", clientMessageId: "msg-2" }));

    store.consumePending({ serverId: "server-1", workspaceId: "workspace-1", draftId: "draft-1" });

    const remaining = useWorkspaceDraftSubmissionStore.getState().pendingByDraftId;
    expect(remaining["draft-1"]).toBeUndefined();
    expect(remaining["draft-2"]?.clientMessageId).toBe("msg-2");
  });

  it("returns null when the pending does not match the requested identity", () => {
    const store = useWorkspaceDraftSubmissionStore.getState();
    store.setPending(buildSubmission({ draftId: "draft-1", workspaceId: "workspace-1" }));

    const result = store.consumePending({
      serverId: "server-1",
      workspaceId: "workspace-OTHER",
      draftId: "draft-1",
    });

    expect(result).toBeNull();
    // A non-matching consume must not remove the entry.
    expect(
      useWorkspaceDraftSubmissionStore.getState().pendingByDraftId["draft-1"],
    ).not.toBeUndefined();
  });
});
