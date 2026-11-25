import { describe, expect, it } from "vitest";
import { createWebPopStateGuard, type PopStateWindowLike } from "./index.web";

interface FakeHistoryEntry {
  state: unknown;
  path: string;
}

function createFakeWindow(initialEntries: FakeHistoryEntry[]) {
  let entries = [...initialEntries];
  let index = entries.length - 1;
  const listeners: Array<(event: PopStateEvent) => void> = [];

  const current = () => entries[index] ?? { state: null, path: "/" };

  const firePopState = () => {
    let stopped = false;
    const event = {
      state: current().state,
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
    get location() {
      const url = new URL(current().path, "http://localhost");
      return { pathname: url.pathname, search: url.search, hash: url.hash };
    },
    history: {
      pushState(state, _unused, url) {
        const path = typeof url === "string" ? url : String(url ?? "/");
        entries = entries.slice(0, index + 1);
        entries.push({ state, path });
        index = entries.length - 1;
      },
      back() {
        if (index > 0) {
          index -= 1;
          firePopState();
        }
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
  };

  return {
    win,
    getPath: () => current().path,
    getState: () => current().state,
    simulateBrowserBack: () => {
      if (index > 0) {
        index -= 1;
      }
      return firePopState();
    },
  };
}

describe("createWebPopStateGuard", () => {
  it("vetoes browser Back when dirty and user cancels, keeping route and state", async () => {
    const fake = createFakeWindow([
      { state: { id: "id-0" }, path: "/open-project" },
      { state: { id: "id-1" }, path: "/settings/hosts/srv/agent-profiles" },
    ]);
    const guard = createWebPopStateGuard(fake.win);
    guard.install();

    let routerSawPopState = 0;
    fake.win.addEventListener("popstate", () => {
      routerSawPopState += 1;
    });

    let dirty = true;
    guard.register({
      isDirty: () => dirty,
      confirmDiscard: async () => false,
      getCurrentEntry: () => ({
        state: { id: "id-1" },
        path: "/settings/hosts/srv/agent-profiles",
      }),
    });

    const { stopped } = fake.simulateBrowserBack();
    await Promise.resolve();

    expect(stopped).toBe(true);
    expect(routerSawPopState).toBe(0);
    expect(fake.getPath()).toBe("/settings/hosts/srv/agent-profiles");
    expect(fake.getState()).toEqual({ id: "id-1" });
    expect(dirty).toBe(true);
  });

  it("replays browser Back to the router after the user confirms discard", async () => {
    const fake = createFakeWindow([
      { state: { id: "id-0" }, path: "/open-project" },
      { state: { id: "id-1" }, path: "/settings/hosts/srv/agent-profiles" },
    ]);
    const guard = createWebPopStateGuard(fake.win);
    guard.install();

    const routerSeenPaths: string[] = [];
    fake.win.addEventListener("popstate", () => {
      routerSeenPaths.push(fake.getPath());
    });

    let dirty = true;
    guard.register({
      isDirty: () => dirty,
      confirmDiscard: async () => {
        dirty = false;
        return true;
      },
      getCurrentEntry: () => ({
        state: { id: "id-1" },
        path: "/settings/hosts/srv/agent-profiles",
      }),
    });

    fake.simulateBrowserBack();
    await Promise.resolve();
    await Promise.resolve();

    expect(routerSeenPaths).toEqual(["/open-project"]);
    expect(fake.getPath()).toBe("/open-project");
  });

  it("passes browser Back straight through when the guard is not dirty", () => {
    const fake = createFakeWindow([
      { state: { id: "id-0" }, path: "/open-project" },
      { state: { id: "id-1" }, path: "/settings/hosts/srv/agent-profiles" },
    ]);
    const guard = createWebPopStateGuard(fake.win);
    guard.install();

    let routerSawPopState = 0;
    fake.win.addEventListener("popstate", () => {
      routerSawPopState += 1;
    });

    guard.register({
      isDirty: () => false,
      confirmDiscard: async () => {
        throw new Error("should not prompt when clean");
      },
      getCurrentEntry: () => ({
        state: { id: "id-1" },
        path: "/settings/hosts/srv/agent-profiles",
      }),
    });

    const { stopped } = fake.simulateBrowserBack();

    expect(stopped).toBe(false);
    expect(routerSawPopState).toBe(1);
    expect(fake.getPath()).toBe("/open-project");
  });
});
