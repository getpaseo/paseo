import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createExplorerTerminalStore, excludeExplorerTerminals } from "./explorer-terminal-store";

describe("Explorer terminal preferences", () => {
  it("keeps shell, script selection, and height isolated and restores them", async () => {
    const values = new Map<string, string>();
    const storage: StateStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    const first = createExplorerTerminalStore(storage);
    first.getState().update("host:one", { shellId: "shell-1", height: 0.42 });
    first.getState().update("host:one", { scriptId: "script-1", selected: "script" });
    first.getState().update("host:two", { shellId: "shell-2" });
    first.getState().setPending("host:one", true);
    first.getState().setPending("host:one", true);
    first.getState().setPending("host:one", false);
    expect(first.getState().pendingByWorkspace["host:one"]).toBe(1);

    const restored = createExplorerTerminalStore(storage);
    await restored.persist.rehydrate();

    expect(restored.getState().byWorkspace).toEqual({
      "host:one": { shellId: "shell-1", scriptId: "script-1", selected: "script", height: 0.42 },
      "host:two": { shellId: "shell-2", selected: "shell", height: 0.35 },
    });
    expect(restored.getState().pendingByWorkspace).toEqual({});
    expect(
      excludeExplorerTerminals(
        ["shell-1", "script-1", "ordinary"],
        restored.getState().byWorkspace["host:one"],
      ),
    ).toEqual(["ordinary"]);
  });
});
