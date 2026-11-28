import { describe, expect, it } from "vitest";
import { createDesktopWindowOwner, type OwnedDesktopWindow } from "./desktop-window-owner.js";

function harness(beforeCreate?: Promise<void>) {
  const windows: OwnedDesktopWindow[] = [];
  const launches: Array<{ initialRoute: string | null; restoreWindowState: boolean }> = [];
  let nextId = 1;
  let focused: OwnedDesktopWindow | null = null;
  let closeWindow = (_id: number) => {};
  const owner = createDesktopWindowOwner({
    async create(input) {
      launches.push({
        initialRoute: input.initialRoute,
        restoreWindowState: input.restoreWindowState,
      });
      if (beforeCreate) await beforeCreate;
      const id = nextId++;
      closeWindow = input.onClosed;
      const window: OwnedDesktopWindow = {
        webContentsId: id,
        isDestroyed: () => false,
        isVisible: () => true,
        isMinimized: () => false,
        restore: () => {},
        show: () => {},
        focus: () => {},
      };
      windows.push(window);
      input.onCreated(id);
      return window;
    },
    windows: () => windows,
    focusedWindow: () => focused,
  });
  return {
    owner,
    launches,
    windows,
    setFocused: (window: OwnedDesktopWindow) => {
      focused = window;
    },
    close: (id: number) => closeWindow(id),
  };
}

describe("desktop window owner", () => {
  it("restores only primary launches and routes pending projects per window", async () => {
    const h = harness();
    await h.owner.openPrimary({ pendingProjectPath: " /project/a " });
    await h.owner.openAdditional({ pendingProjectPath: "/project/b" });
    expect(h.launches).toEqual([
      { initialRoute: null, restoreWindowState: true },
      { initialRoute: null, restoreWindowState: false },
    ]);
    expect(h.owner.takePendingProject(1)).toBe("/project/a");
    expect(h.owner.takePendingProject(2)).toBe("/project/b");
  });

  it("delivers a link to the focused app window", async () => {
    const h = harness();
    await h.owner.openPrimary();
    await h.owner.openAdditional();
    h.setFocused(h.windows[1]);
    const delivered: number[] = [];
    await h.owner.openOrFocusLink({
      initialRoute: "/agent/agent-7",
      deliver: (windowId) => delivered.push(windowId),
    });
    expect(h.launches).toHaveLength(2);
    expect(delivered).toEqual([2]);
  });

  it.each(["workspace", "agent"] as const)(
    "reuses the window when a %s link arrives first and creation has not registered a window",
    async (first) => {
      const creation = Promise.withResolvers<void>();
      const h = harness(creation.promise);
      const delivered: Array<{ link: string; windowId: number }> = [];
      const links = {
        workspace: {
          deliver: (windowId: number) => delivered.push({ link: "workspace", windowId }),
        },
        agent: {
          initialRoute: "/agent/agent-7",
          deliver: (windowId: number) => delivered.push({ link: "agent", windowId }),
        },
      };
      const latest = first === "workspace" ? "agent" : "workspace";
      const firstOpen = h.owner.openOrFocusLink(links[first]);
      expect(h.windows).toHaveLength(0);
      const secondOpen = h.owner.openOrFocusLink(links[latest]);
      creation.resolve();

      await Promise.all([firstOpen, secondOpen]);

      expect(h.launches).toEqual([
        { initialRoute: first === "agent" ? "/agent/agent-7" : null, restoreWindowState: true },
      ]);
      expect(h.windows).toHaveLength(1);
      expect(delivered).toEqual([{ link: latest, windowId: 1 }]);
    },
  );

  it("removes pending routing state when a window closes", async () => {
    const h = harness();
    await h.owner.openAdditional({ pendingProjectPath: "/project/a" });
    h.close(1);
    expect(h.owner.takePendingProject(1)).toBeNull();
  });
});
