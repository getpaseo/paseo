/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import type { DaemonClient } from "@server/client/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useArchiveSubagent } from "@/subagents";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { resolveArchiveSubagentDialog } from "./use-archive-subagent";

const { archiveAgentMock, confirmDialogMock } = vi.hoisted(() => ({
  archiveAgentMock: vi.fn(),
  confirmDialogMock: vi.fn(),
}));

vi.mock("@/hooks/use-archive-agent", () => ({
  useArchiveAgent: () => ({
    archiveAgent: archiveAgentMock,
  }),
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: confirmDialogMock,
}));

vi.mock("./section", () => ({
  SubagentsSection: () => null,
}));

const SERVER_ID = "server-1";

function makeAgent(input: { id: string; title?: Agent["title"]; status?: Agent["status"] }): Agent {
  const createdAt = new Date("2026-03-04T00:00:00.000Z");
  return {
    serverId: SERVER_ID,
    id: input.id,
    provider: "codex",
    status: input.status ?? "idle",
    createdAt,
    updatedAt: createdAt,
    lastUserMessageAt: null,
    lastActivityAt: createdAt,
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
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: input.title ?? null,
    cwd: "/repo/worktree",
    model: null,
    thinkingOptionId: null,
    parentAgentId: "parent-agent",
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
  };
}

function seedSubagent(subagent: Agent): void {
  const client = { archiveAgent: vi.fn() } as unknown as DaemonClient;
  useSessionStore.getState().initializeSession(SERVER_ID, client);
  useSessionStore.getState().setAgents(SERVER_ID, new Map([[subagent.id, subagent]]));
}

describe("resolveArchiveSubagentDialog", () => {
  it("uses running copy for running subagents", () => {
    expect(
      resolveArchiveSubagentDialog({
        title: "Review branch",
        status: "running",
      }),
    ).toEqual({
      title: "Archive running subagent?",
      message:
        "Review branch is still running. Archiving it will stop the subagent and remove it from the track.",
      confirmLabel: "Archive",
      cancelLabel: "Cancel",
      destructive: true,
    });
  });

  it("uses running copy for initializing subagents", () => {
    expect(
      resolveArchiveSubagentDialog({
        title: "Starting child",
        status: "initializing",
      }),
    ).toEqual({
      title: "Archive running subagent?",
      message:
        "Starting child is still running. Archiving it will stop the subagent and remove it from the track.",
      confirmLabel: "Archive",
      cancelLabel: "Cancel",
      destructive: true,
    });
  });

  it("uses idle copy for non-running subagents", () => {
    expect(
      resolveArchiveSubagentDialog({
        title: "Review branch",
        status: "idle",
      }),
    ).toEqual({
      title: "Archive subagent?",
      message: "Remove Review branch from the track. The subagent will be archived.",
      confirmLabel: "Archive",
      cancelLabel: "Cancel",
      destructive: true,
    });
  });

  it("falls back to this subagent when the title is not displayable", () => {
    expect(
      resolveArchiveSubagentDialog({
        title: "New Agent",
        status: null,
      }),
    ).toEqual({
      title: "Archive subagent?",
      message: "Remove this subagent from the track. The subagent will be archived.",
      confirmLabel: "Archive",
      cancelLabel: "Cancel",
      destructive: true,
    });
  });
});

describe("useArchiveSubagent", () => {
  beforeEach(() => {
    archiveAgentMock.mockReset();
    archiveAgentMock.mockResolvedValue(undefined);
    confirmDialogMock.mockReset();
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  afterEach(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  it("archives the subagent with the server id when the user confirms", async () => {
    const subagent = makeAgent({
      id: "child-agent",
      title: "Review branch",
      status: "running",
    });
    seedSubagent(subagent);
    confirmDialogMock.mockResolvedValue(true);

    const { result } = renderHook(() => useArchiveSubagent({ serverId: SERVER_ID }));

    await act(async () => {
      await (result.current as (subagentId: string) => Promise<void>)(subagent.id);
    });

    expect(archiveAgentMock).toHaveBeenCalledTimes(1);
    expect(archiveAgentMock).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      agentId: subagent.id,
    });
  });

  it("does not archive the subagent when the user cancels", async () => {
    const subagent = makeAgent({
      id: "child-agent",
      title: "Review branch",
      status: "idle",
    });
    seedSubagent(subagent);
    confirmDialogMock.mockResolvedValue(false);

    const { result } = renderHook(() => useArchiveSubagent({ serverId: SERVER_ID }));

    await act(async () => {
      await (result.current as (subagentId: string) => Promise<void>)(subagent.id);
    });

    expect(archiveAgentMock).not.toHaveBeenCalled();
  });

  it("passes the resolved dialog input for the subagent to confirmDialog", async () => {
    const subagent = makeAgent({
      id: "child-agent",
      title: "Review branch",
      status: "running",
    });
    seedSubagent(subagent);
    confirmDialogMock.mockResolvedValue(false);

    const { result } = renderHook(() => useArchiveSubagent({ serverId: SERVER_ID }));

    await act(async () => {
      await (result.current as (subagentId: string) => Promise<void>)(subagent.id);
    });

    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect(confirmDialogMock).toHaveBeenCalledWith(
      resolveArchiveSubagentDialog({
        title: subagent.title,
        status: subagent.status,
      }),
    );
  });
});
