import { describe, expect, it } from "vitest";
import { createDesktopWindowOwner, type OwnedDesktopWindow } from "./desktop-window-owner.js";

interface Target {
  id: string;
}

function harness(
  options: { preferredWindow?: (target: Target) => OwnedDesktopWindow<Target> | null } = {},
) {
  const windows: OwnedDesktopWindow<Target>[] = [];
  const launches: Array<{ initialRoute: string | null; restoreWindowState: boolean }> = [];
  const sent: Target[] = [];
  const focusCalls: number[] = [];
  let nextId = 1;
  let focused: OwnedDesktopWindow<Target> | null = null;
  let closeWindow = (_id: number) => {};
  const owner = createDesktopWindowOwner<Target>({
    async create(input) {
      launches.push({
        initialRoute: input.initialRoute,
        restoreWindowState: input.restoreWindowState,
      });
      const id = nextId++;
      closeWindow = input.onClosed;
      const window: OwnedDesktopWindow<Target> = {
        webContentsId: id,
        isDestroyed: () => false,
        isVisible: () => true,
        isMinimized: () => false,
        restore: () => {},
        show: () => {},
        focus: () => focusCalls.push(id),
        sendAgent: (target) => sent.push(target),
      };
      windows.push(window);
      input.onCreated(id);
      return window;
    },
    windows: () => windows,
    focusedWindow: () => focused,
    agentRoute: (target) => `/agent/${target.id}`,
    deliverAgent: (_id, target) => target,
    preferredWindow: options.preferredWindow,
  });
  return {
    owner,
    launches,
    sent,
    windows,
    focusCalls,
    setFocused: (window: OwnedDesktopWindow<Target>) => {
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

  it("focuses an existing window and delivers agent routing through its inbox", async () => {
    const h = harness();
    await h.owner.openPrimary();
    h.setFocused(h.windows[0]);
    await h.owner.openOrFocusAgent({ id: "agent-7" });
    expect(h.launches).toHaveLength(1);
    expect(h.sent).toEqual([{ id: "agent-7" }]);
  });

  it("removes pending routing state when a window closes", async () => {
    const h = harness();
    await h.owner.openAdditional({ pendingProjectPath: "/project/a" });
    h.close(1);
    expect(h.owner.takePendingProject(1)).toBeNull();
  });

  it("prefers the window already showing the target over the focused window", async () => {
    let preferred: OwnedDesktopWindow<Target> | null = null;
    const h = harness({ preferredWindow: () => preferred });
    await h.owner.openPrimary();
    await h.owner.openAdditional();
    h.setFocused(h.windows[0]);
    preferred = h.windows[1];

    await h.owner.openOrFocusAgent({ id: "agent-7" });

    expect(h.focusCalls).toEqual([2]);
    expect(h.sent).toEqual([{ id: "agent-7" }]);
  });

  it("falls back to the focused window when preferredWindow finds no match", async () => {
    const h = harness({ preferredWindow: () => null });
    await h.owner.openPrimary();
    h.setFocused(h.windows[0]);

    await h.owner.openOrFocusAgent({ id: "agent-7" });

    expect(h.focusCalls).toEqual([1]);
    expect(h.sent).toEqual([{ id: "agent-7" }]);
  });
});
