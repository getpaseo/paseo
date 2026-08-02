import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopListItem } from "@getpaseo/protocol/loop/rpc-schemas";
import { refreshLoops, selectLoopsForAgentFromStore, useLoopStore } from "./store";

function loop(partial: Partial<LoopListItem> & Pick<LoopListItem, "id">): LoopListItem {
  return {
    name: partial.name ?? null,
    status: partial.status ?? "running",
    cwd: partial.cwd ?? "/tmp",
    createdAt: partial.createdAt ?? "2026-08-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-08-01T00:00:00.000Z",
    activeIteration: partial.activeIteration ?? null,
    activeWorkerAgentId: partial.activeWorkerAgentId ?? null,
    activeVerifierAgentId: partial.activeVerifierAgentId ?? null,
    ...partial,
  };
}

describe("loop store", () => {
  beforeEach(() => {
    useLoopStore.setState({ loopsByServer: new Map() });
  });

  it("replaces loops for a server", () => {
    useLoopStore.getState().replaceList("srv", [
      loop({
        id: "loop-1",
        name: "One",
        activeWorkerAgentId: "agent-a",
      }),
    ]);
    const all = useLoopStore.getState().loopsByServer.get("srv") ?? [];
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("loop-1");
  });

  it("selects running worker/verifier membership for an agent", () => {
    useLoopStore.getState().replaceList("srv", [
      loop({
        id: "loop-1",
        name: "Worker",
        activeWorkerAgentId: "agent-a",
        activeIteration: 2,
      }),
      loop({
        id: "loop-2",
        name: "Other",
        activeWorkerAgentId: "agent-b",
      }),
    ]);
    const rows = selectLoopsForAgentFromStore(
      useLoopStore.getState().loopsByServer,
      "srv",
      "agent-a",
    );
    expect(rows.map((row) => row.loopId)).toEqual(["loop-1"]);
    expect(rows[0]?.role).toBe("worker");
  });

  it("refreshLoops caches loopList payload and dedupes in-flight requests", async () => {
    const loops = [
      loop({
        id: "loop-1",
        name: "Cached",
        activeVerifierAgentId: "agent-a",
      }),
    ];
    const loopList = vi.fn(async () => ({
      requestId: "req-1",
      loops,
      error: null,
    }));
    const client = { loopList };

    const first = refreshLoops(client, "srv");
    const second = refreshLoops(client, "srv");
    expect(second).toBe(first);
    await first;

    expect(loopList).toHaveBeenCalledTimes(1);
    expect(useLoopStore.getState().loopsByServer.get("srv")).toEqual(loops);
  });
});
