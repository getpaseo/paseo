import { describe, expect, it } from "vitest";
import type { DaemonClient, FetchAgentsEntry } from "@server/client/daemon-client";
import type { AgentSnapshotPayload } from "@server/shared/messages";
import { PARENT_AGENT_ID_LABEL } from "@server/shared/agent-labels";
import { useSessionStore } from "@/stores/session-store";
import { replaceFetchedAgentDirectory } from "./agent-directory-sync";

function createAgentPayload(
  input: Partial<Omit<AgentSnapshotPayload, "labels">> & {
    id: string;
    labels?: Record<string, string>;
  },
): AgentSnapshotPayload {
  return {
    id: input.id,
    provider: input.provider ?? "codex",
    cwd: input.cwd ?? "/repo",
    model: input.model ?? null,
    createdAt: input.createdAt ?? "2026-04-20T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-04-20T00:01:00.000Z",
    lastUserMessageAt: input.lastUserMessageAt ?? null,
    status: input.status ?? "idle",
    capabilities: input.capabilities ?? {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: input.currentModeId ?? null,
    availableModes: input.availableModes ?? [],
    pendingPermissions: input.pendingPermissions ?? [],
    persistence: input.persistence ?? null,
    title: input.title ?? null,
    labels: input.labels ?? {},
  };
}

function createEntry(agent: AgentSnapshotPayload): FetchAgentsEntry {
  return {
    agent,
    project: {
      projectKey: agent.cwd,
      projectName: "repo",
      checkout: {
        cwd: agent.cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

describe("replaceFetchedAgentDirectory", () => {
  it("re-derives parentAgentId every time an agent snapshot is ingested", () => {
    const serverId = "server-1";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);

    replaceFetchedAgentDirectory({
      serverId,
      entries: [
        createEntry(
          createAgentPayload({
            id: "child-1",
            labels: { [PARENT_AGENT_ID_LABEL]: "parent-a" },
          }),
        ),
      ],
    });

    replaceFetchedAgentDirectory({
      serverId,
      entries: [
        createEntry(
          createAgentPayload({
            id: "child-1",
            labels: { [PARENT_AGENT_ID_LABEL]: "parent-b" },
          }),
        ),
      ],
    });

    expect(
      useSessionStore.getState().sessions[serverId]?.agents.get("child-1")?.parentAgentId,
    ).toBe("parent-b");

    store.clearSession(serverId);
  });
});
