import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderHeartbeatDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  refreshProviderHeartbeats,
  selectProviderHeartbeatsForParent,
  useProviderHeartbeatStore,
} from "./provider-store";

function heartbeat(
  overrides: Partial<ProviderHeartbeatDescriptorPayload> &
    Pick<ProviderHeartbeatDescriptorPayload, "taskId" | "parentAgentId">,
): ProviderHeartbeatDescriptorPayload {
  return {
    provider: "claude",
    prompt: "check deploy",
    mode: "recurring",
    scheduleLabel: "every 5m",
    nextHint: "in 4m",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("provider heartbeat store", () => {
  beforeEach(() => {
    useProviderHeartbeatStore.setState({ heartbeats: new Map() });
  });

  it("replaces heartbeats for a parent agent", () => {
    useProviderHeartbeatStore
      .getState()
      .replaceList("srv", "agent-1", [heartbeat({ taskId: "hb-1", parentAgentId: "agent-1" })]);
    const all = [...useProviderHeartbeatStore.getState().heartbeats.values()];
    expect(all).toHaveLength(1);
    expect(all[0]?.taskId).toBe("hb-1");
  });

  it("selects only the parent agent heartbeats", () => {
    useProviderHeartbeatStore
      .getState()
      .replaceList("srv", "agent-1", [heartbeat({ taskId: "hb-1", parentAgentId: "agent-1" })]);
    useProviderHeartbeatStore
      .getState()
      .replaceList("srv", "agent-2", [heartbeat({ taskId: "hb-2", parentAgentId: "agent-2" })]);
    const rows = selectProviderHeartbeatsForParent(
      useProviderHeartbeatStore.getState().heartbeats,
      "srv",
      "agent-1",
    );
    expect(rows.map((row) => row.taskId)).toEqual(["hb-1"]);
  });

  it("applyUpdate replaces the parent list", () => {
    useProviderHeartbeatStore
      .getState()
      .replaceList("srv", "agent-1", [heartbeat({ taskId: "hb-old", parentAgentId: "agent-1" })]);
    useProviderHeartbeatStore.getState().applyUpdate("srv", {
      parentAgentId: "agent-1",
      heartbeats: [heartbeat({ taskId: "hb-new", parentAgentId: "agent-1" })],
    });
    const rows = selectProviderHeartbeatsForParent(
      useProviderHeartbeatStore.getState().heartbeats,
      "srv",
      "agent-1",
    );
    expect(rows.map((row) => row.taskId)).toEqual(["hb-new"]);
  });

  it("refreshProviderHeartbeats loads and stores list payload", async () => {
    const listProviderHeartbeats = vi.fn().mockResolvedValue({
      requestId: "r1",
      parentAgentId: "agent-1",
      heartbeats: [heartbeat({ taskId: "hb-1", parentAgentId: "agent-1" })],
      error: null,
    });
    await refreshProviderHeartbeats({ listProviderHeartbeats }, "srv", "agent-1");
    const rows = selectProviderHeartbeatsForParent(
      useProviderHeartbeatStore.getState().heartbeats,
      "srv",
      "agent-1",
    );
    expect(listProviderHeartbeats).toHaveBeenCalledWith("agent-1");
    expect(rows.map((row) => row.taskId)).toEqual(["hb-1"]);
  });
});
