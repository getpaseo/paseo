import { describe, expect, it } from "vitest";
import type { EvaluatedWorkspaceRowAccessory, InstalledPlugin } from "./types";
import { endRowTakeoversOf, getRowTakeover, startRowTakeover } from "./workspace-row-takeover";

function Component() {
  return null;
}
function Overlay() {
  return null;
}

function accessories(
  ...entries: Partial<EvaluatedWorkspaceRowAccessory>[]
): EvaluatedWorkspaceRowAccessory[] {
  return entries.map((entry, index) =>
    Object.assign(
      { id: `accessory-${index}`, Component, size: "status" as const, sequence: index + 1 },
      entry,
    ),
  );
}

function plugin(serverId: string) {
  return {
    id: "row-fixture",
    serverId,
    lifetime: new AbortController(),
  } as unknown as InstalledPlugin;
}

describe("startRowTakeover", () => {
  it("plays one takeover per row and completes it when its time is up", async () => {
    const owner = plugin("host-a");
    const registered = accessories({ Overlay });

    const handle = startRowTakeover(owner, registered, "ws-1", { durationMs: 20, data: "sweep" });

    expect(getRowTakeover("host-a:ws-1")).toMatchObject({ Overlay, data: "sweep" });
    expect(startRowTakeover(owner, registered, "ws-1", { durationMs: 20 })).toBeNull();
    expect(startRowTakeover(owner, registered, "ws-2", { durationMs: 20 })).not.toBeNull();

    await expect(handle?.finished).resolves.toBe("completed");
    expect(getRowTakeover("host-a:ws-1")).toBeNull();
  });

  it("ends a takeover when the plugin cancels it, its Overlay fails, or it is disposed", async () => {
    const owner = plugin("host-b");
    const registered = accessories({ Overlay });

    const cancelled = startRowTakeover(owner, registered, "ws-1", { durationMs: 3000 });
    cancelled?.cancel();
    await expect(cancelled?.finished).resolves.toBe("cancelled");
    expect(getRowTakeover("host-b:ws-1")).toBeNull();

    const failed = startRowTakeover(owner, registered, "ws-1", { durationMs: 3000 });
    getRowTakeover("host-b:ws-1")?.cancel();
    await expect(failed?.finished).resolves.toBe("cancelled");

    const disposed = startRowTakeover(owner, registered, "ws-1", { durationMs: 3000 });
    owner.lifetime.abort();
    await expect(disposed?.finished).resolves.toBe("cancelled");
    expect(startRowTakeover(owner, registered, "ws-1", { durationMs: 3000 })).toBeNull();
  });

  it("uses the Overlay of the latest accessory that has one, from the list it is given", () => {
    const Later = () => null;
    const owner = plugin("host-c");

    const handle = startRowTakeover(
      owner,
      accessories({ Overlay }, { Overlay: Later }, {}),
      "ws-1",
      {
        durationMs: 3000,
      },
    );

    expect(getRowTakeover("host-c:ws-1")?.Overlay).toBe(Later);
    handle?.cancel();
  });

  it("ends a takeover when the plugin removes the accessory it plays", async () => {
    const owner = plugin("host-e");
    const [playing] = accessories({ Overlay });
    const [other] = accessories({ Overlay });

    const handle = startRowTakeover(owner, [playing!], "ws-1", { durationMs: 3000 });
    endRowTakeoversOf(other!);
    expect(getRowTakeover("host-e:ws-1")).not.toBeNull();

    endRowTakeoversOf(playing!);
    await expect(handle?.finished).resolves.toBe("cancelled");
    expect(getRowTakeover("host-e:ws-1")).toBeNull();
  });

  it("rejects malformed requests and plugins without an Overlay", () => {
    const owner = plugin("host-d");

    expect(() => startRowTakeover(owner, accessories({}), "ws-1", { durationMs: 1000 })).toThrow(
      "needs a row accessory with an Overlay",
    );
    expect(() =>
      startRowTakeover(owner, accessories({ Overlay }), "ws-1", { durationMs: 0 }),
    ).toThrow("durationMs");
    expect(() =>
      startRowTakeover(owner, accessories({ Overlay }), "ws-1", { durationMs: 10_001 }),
    ).toThrow("durationMs");
  });
});
