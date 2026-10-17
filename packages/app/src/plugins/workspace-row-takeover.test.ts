/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluatedWorkspaceRowAccessory, InstalledPlugin } from "./types";
import { startRowTakeover, useRowTakeover } from "./workspace-row-takeover";

function Component() {
  return null;
}
function Overlay() {
  return null;
}

function plugin(serverId: string, accessories: Partial<EvaluatedWorkspaceRowAccessory>[]) {
  return {
    id: "row-example",
    serverId,
    lifetime: new AbortController(),
    workspaceRowAccessories: accessories.map((entry, index) => ({
      id: `accessory-${index}`,
      Component,
      size: "status",
      sequence: index + 1,
      ...entry,
    })),
  } as unknown as InstalledPlugin;
}

const takeoverOf = (key: string) => renderHook(() => useRowTakeover(key)).result.current;

describe("startRowTakeover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("plays one takeover per row and completes it when its time is up", async () => {
    const owner = plugin("host-a", [{ Overlay }]);

    const handle = startRowTakeover(owner, "ws-1", { durationMs: 3000, data: "sweep" });

    expect(takeoverOf("host-a:ws-1")).toMatchObject({ Overlay, data: "sweep" });
    expect(startRowTakeover(owner, "ws-1", { durationMs: 1000 })).toBeNull();
    expect(startRowTakeover(owner, "ws-2", { durationMs: 1000 })).not.toBeNull();

    vi.advanceTimersByTime(3000);

    await expect(handle?.finished).resolves.toBe("completed");
    expect(takeoverOf("host-a:ws-1")).toBeNull();
  });

  it("ends a takeover when the plugin cancels it or is disposed", async () => {
    const owner = plugin("host-b", [{ Overlay }]);

    const cancelled = startRowTakeover(owner, "ws-1", { durationMs: 3000 });
    cancelled?.cancel();
    const disposed = startRowTakeover(owner, "ws-1", { durationMs: 3000 });
    owner.lifetime.abort();

    await expect(cancelled?.finished).resolves.toBe("cancelled");
    await expect(disposed?.finished).resolves.toBe("cancelled");
    expect(takeoverOf("host-b:ws-1")).toBeNull();
    expect(startRowTakeover(owner, "ws-1", { durationMs: 3000 })).toBeNull();
  });

  it("rejects malformed requests and plugins without an Overlay", () => {
    const owner = plugin("host-c", [{ Overlay }]);
    for (const options of [{ durationMs: 0 }, { durationMs: 20_000 }]) {
      expect(() => startRowTakeover(owner, "ws-1", options)).toThrow("Invalid row takeover");
    }
    const plain = plugin("host-c", [{}]);
    expect(() => startRowTakeover(plain, "ws-1", { durationMs: 1000 })).toThrow("Overlay");
  });
});
