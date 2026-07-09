import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { buildWorkspaceAgentActivityIndex } from "./workspace-agent-activity";

function agent(input: {
  id: string;
  workspaceId?: string;
  status?: Agent["status"];
  updatedAt: string;
  attentionTimestamp?: string | null;
  requiresAttention?: boolean;
  attentionReason?: Agent["attentionReason"];
  pendingPermissionCount?: number;
  archivedAt?: string | null;
  parentAgentId?: string | null;
}): Agent {
  return {
    serverId: "host-a",
    id: input.id,
    provider: "codex",
    status: input.status ?? "idle",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date(input.updatedAt),
    lastUserMessageAt: null,
    lastActivityAt: new Date(input.updatedAt),
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
    pendingPermissions: Array.from({ length: input.pendingPermissionCount ?? 0 }, (_, index) => ({
      id: `permission-${index}`,
      provider: "codex",
      name: "shell",
      kind: "tool",
      input: {},
    })),
    persistence: null,
    title: null,
    cwd: "/repo",
    workspaceId: input.workspaceId,
    model: null,
    requiresAttention: input.requiresAttention,
    attentionReason: input.attentionReason,
    attentionTimestamp: input.attentionTimestamp ? new Date(input.attentionTimestamp) : null,
    archivedAt: input.archivedAt ? new Date(input.archivedAt) : null,
    parentAgentId: input.parentAgentId ?? null,
    labels: {},
  };
}

describe("workspace agent activity index", () => {
  it("keeps the latest active root agent for each workspace", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "older",
          agent({
            id: "older",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "permission",
          agent({
            id: "permission",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:01:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
        [
          "attention",
          agent({
            id: "attention",
            workspaceId: "workspace-b",
            updatedAt: "2026-06-01T10:00:00.000Z",
            attentionTimestamp: "2026-06-01T10:02:00.000Z",
            requiresAttention: true,
            attentionReason: "finished",
          }),
        ],
      ]),
    );

    expect(index).toEqual(
      new Map([
        ["workspace-a", { status: "needs_input", enteredAt: new Date("2026-06-01T10:01:00.000Z") }],
        ["workspace-b", { status: "attention", enteredAt: new Date("2026-06-01T10:02:00.000Z") }],
      ]),
    );
  });

  it("does not let archived or child agents change root workspace activity", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "child",
          agent({
            id: "child",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:03:00.000Z",
            pendingPermissionCount: 1,
            parentAgentId: "root",
          }),
        ],
        [
          "archived",
          agent({
            id: "archived",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:04:00.000Z",
            requiresAttention: true,
            attentionReason: "error",
            archivedAt: "2026-06-01T10:04:00.000Z",
          }),
        ],
      ]),
    );

    expect(index.get("workspace-a")).toEqual({
      status: "running",
      enteredAt: new Date("2026-06-01T10:00:00.000Z"),
    });
  });
});
