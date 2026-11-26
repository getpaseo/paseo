import { describe, expect, it } from "vitest";
import {
  createWebPopStateGuard,
  type PopStateStorageLike,
  type PopStateWindowLike,
} from "./index.web";

interface FakeHistoryEntry {
  state: unknown;
  path: string;
}

function createMemoryStorage(): PopStateStorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

function createFakeWindow(
  initialEntries: FakeHistoryEntry[],
  options?: { index?: number; sessionStorage?: PopStateStorageLike },
) {
  let entries: FakeHistoryEntry[] = [...initialEntries];
  let index = options?.index ?? entries.length - 1;
  const listeners: Array<(event: PopStateEvent) => void> = [];

  const current = () => entries[index] ?? { state: null, path: "/" };

  const dispatchPopState = (state: unknown) => {
    let stopped = false;
    const event = {
      state,
      stopImmediatePropagation() {
        stopped = true;
      },
    } as unknown as PopStateEvent;
    for (const listener of listeners.slice()) {
      if (stopped) {
        break;
      }
      listener(event);
    }
    return { stopped };
  };

  const win: PopStateWindowLike = {
    ...(options?.sessionStorage ? { sessionStorage: options.sessionStorage } : {}),
    history: {
      get state() {
        return current().state;
      },
      pushState(state, _unused, url) {
        const path = typeof url === "string" ? url : String(url ?? "/");
        entries = entries.slice(0, index + 1);
        entries.push({ state, path });
        index = entries.length - 1;
      },
      replaceState(state, _unused, url) {
        const path = typeof url === "string" ? url : String(url ?? "/");
        entries[index] = { state, path };
      },
      go(delta = 0) {
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= entries.length || nextIndex === index) {
          return;
        }
        index = nextIndex;
        dispatchPopState(current().state);
      },
    },
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
    removeEventListener(_type, listener) {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) {
        listeners.splice(idx, 1);
      }
    },
    dispatchEvent(event) {
      const popEvent = event as PopStateEvent;
      dispatchPopState(popEvent.state);
      return true;
    },
  };

  return {
    win,
    getPath: () => current().path,
    getEntries: () => entries.map((entry) => entry.path),
    getIndex: () => index,
    simulateHistoryJump: (delta: number) => {
      const nextIndex = index + delta;
      index = Math.max(0, Math.min(entries.length - 1, nextIndex));
      return dispatchPopState(current().state);
    },
  };
}

describe("createWebPopStateGuard", () => {
  it("preserves intervening history entries when canceling a two-step Back jump", async () => {
    const fake = createFakeWindow([{ state: { id: "id-0" }, path: "/open-project" }], {
      sessionStorage: createMemoryStorage(),
    });
    const guard = createWebPopStateGuard(fake.win);
    guard.install();

    const routerSeenPaths: string[] = [];
    fake.win.addEventListener("popstate", () => {
      routerSeenPaths.push(fake.getPath());
    });

    fake.win.history.pushState({ id: "id-1" }, "", "/settings");
    fake.win.history.pushState({ id: "id-2" }, "", "/settings/hosts/srv/agent-profiles");

    let dirty = true;
    guard.register({
      isDirty: () => dirty,
      confirmDiscard: async () => false,
    });

    // Jump straight from Agent profiles back two entries to Open project and cancel.
    const { stopped } = fake.simulateHistoryJump(-2);
    await Promise.resolve();

    expect(stopped).toBe(true);
    expect(routerSeenPaths).toEqual([]);
    expect(fake.getPath()).toBe("/settings/hosts/srv/agent-profiles");
    expect(fake.getEntries()).toEqual([
      "/open-project",
      "/settings",
      "/settings/hosts/srv/agent-profiles",
    ]);
    expect(fake.getIndex()).toBe(2);

    // After closing the editor, a normal one-step Back still reaches Settings.
    dirty = false;
    fake.simulateHistoryJump(-1);
    expect(fake.getPath()).toBe("/settings");
    expect(routerSeenPaths).toEqual(["/settings"]);
  });

  it("restores the editor URL on a two-step Back jump after a reload (with sessionStorage)", async () => {
    const storage = createMemoryStorage();
    const beforeReload = createFakeWindow([{ state: { id: "id-0" }, path: "/open-project" }], {
      sessionStorage: storage,
    });
    const firstGuard = createWebPopStateGuard(beforeReload.win);
    firstGuard.install();
    beforeReload.win.history.pushState({ id: "id-1" }, "", "/settings");
    beforeReload.win.history.pushState({ id: "id-2" }, "", "/settings/hosts/srv/agent-profiles");
    firstGuard.dispose();

    // Simulate reload on Agent profiles with the same browser history and tab sessionStorage.
    const afterReload = createFakeWindow(
      [
        { state: { id: "id-0" }, path: "/open-project" },
        { state: { id: "id-1" }, path: "/settings" },
        { state: { id: "id-2" }, path: "/settings/hosts/srv/agent-profiles" },
      ],
      { index: 2, sessionStorage: storage },
    );
    const guard = createWebPopStateGuard(afterReload.win);
    guard.install();
    guard.register({
      isDirty: () => true,
      confirmDiscard: async () => false,
    });

    afterReload.simulateHistoryJump(-2);
    await Promise.resolve();

    expect(afterReload.getPath()).toBe("/settings/hosts/srv/agent-profiles");
    expect(afterReload.getIndex()).toBe(2);
  });

  it("steps back to the exact editor entry after a reload even without sessionStorage", async () => {
    const afterReload = createFakeWindow(
      [
        { state: { id: "id-0" }, path: "/open-project" },
        { state: { id: "id-1" }, path: "/settings" },
        { state: { id: "id-2" }, path: "/settings/hosts/srv/agent-profiles" },
      ],
      { index: 2 },
    );
    const guard = createWebPopStateGuard(afterReload.win);
    guard.install();

    const routerSeenPaths: string[] = [];
    afterReload.win.addEventListener("popstate", () => {
      routerSeenPaths.push(afterReload.getPath());
    });

    guard.register({
      isDirty: () => true,
      confirmDiscard: async () => false,
    });

    afterReload.simulateHistoryJump(-2);
    await Promise.resolve();

    expect(routerSeenPaths).toEqual([]);
    expect(afterReload.getPath()).toBe("/settings/hosts/srv/agent-profiles");
    expect(afterReload.getIndex()).toBe(2);
  });

  it("reaches the exact two-step destination when confirming a multi-step Back jump", async () => {
    const fake = createFakeWindow([{ state: { id: "id-0" }, path: "/open-project" }], {
      sessionStorage: createMemoryStorage(),
    });
    const guard = createWebPopStateGuard(fake.win);
    guard.install();

    const routerSeenPaths: string[] = [];
    fake.win.addEventListener("popstate", () => {
      routerSeenPaths.push(fake.getPath());
    });

    fake.win.history.pushState({ id: "id-1" }, "", "/settings");
    fake.win.history.pushState({ id: "id-2" }, "", "/settings/hosts/srv/agent-profiles");

    let dirty = true;
    guard.register({
      isDirty: () => dirty,
      confirmDiscard: async () => {
        dirty = false;
        return true;
      },
    });

    fake.simulateHistoryJump(-2);
    await Promise.resolve();

    expect(routerSeenPaths).toEqual(["/open-project"]);
    expect(fake.getPath()).toBe("/open-project");
    expect(fake.getIndex()).toBe(0);
  });

  it("passes browser Back straight through when the guard is not dirty", () => {
    const fake = createFakeWindow([{ state: { id: "id-0" }, path: "/open-project" }]);
    const guard = createWebPopStateGuard(fake.win);
    guard.install();

    let routerSawPopState = 0;
    fake.win.addEventListener("popstate", () => {
      routerSawPopState += 1;
    });

    fake.win.history.pushState({ id: "id-1" }, "", "/settings/hosts/srv/agent-profiles");

    guard.register({
      isDirty: () => false,
      confirmDiscard: async () => {
        throw new Error("should not prompt when clean");
      },
    });

    const { stopped } = fake.simulateHistoryJump(-1);

    expect(stopped).toBe(false);
    expect(routerSawPopState).toBe(1);
    expect(fake.getPath()).toBe("/open-project");
  });
});
