import { describe, expect, it } from "vitest";
import { createNotificationOpenRouter, parseNotificationOpenTarget } from "./model";
import type { NotificationOpenSource, NotificationTap } from "./source";

class FakeSource implements NotificationOpenSource {
  listeners = new Set<(tap: NotificationTap) => void>();
  acknowledged: string[] = [];
  launchReads = 0;
  constructor(readonly launch: NotificationTap | null) {}
  subscribe(onTap: (tap: NotificationTap) => void) {
    this.listeners.add(onTap);
    return () => {
      this.listeners.delete(onTap);
    };
  }
  async takeLaunchTap() {
    this.launchReads++;
    return this.launch;
  }
  acknowledge(tap: NotificationTap) {
    this.acknowledged.push(tap.id);
  }
  tap(tap: NotificationTap) {
    for (const listener of this.listeners) listener(tap);
  }
}
const launch: NotificationTap = {
  id: "one",
  data: { serverId: "host", workspaceId: "stale", agentId: "agent" },
};
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("notification open", () => {
  it.each([
    [undefined, null],
    [null, null],
    [[], null],
    [{ agentId: "a" }, null],
    [{ serverId: " " }, null],
    [{ serverId: " h " }, { kind: "host", serverId: "h" }],
    [
      { serverId: "h", agentId: "a" },
      { kind: "agent", serverId: "h", agentId: "a" },
    ],
    [
      { serverId: "h", workspaceId: "stale", agentId: "a" },
      { kind: "agent", serverId: "h", agentId: "a" },
    ],
    [
      { serverId: "h", workspaceId: "w", terminalId: "t", agentId: "a" },
      { kind: "terminal", serverId: "h", workspaceId: "w", terminalId: "t" },
    ],
  ])("parses %j", (data, expected) => {
    expect(parseNotificationOpenTarget(data)).toEqual(expected);
  });

  it("consumes launch once across remounts, dedupes listener replay, acknowledges after dispatch", async () => {
    const source = new FakeSource(launch);
    const agents: unknown[] = [];
    const routes: string[] = [];
    let ready = () => {};
    const readiness = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const router = createNotificationOpenRouter({
      source,
      openAgent: (target) => {
        agents.push(target);
      },
      openRoute: (route) => {
        routes.push(route);
      },
      whenReadyToNavigate: () => readiness,
    });
    const stop = router.start();
    source.tap(launch);
    await flush();
    expect(agents).toEqual([]);
    expect(source.acknowledged).toEqual([]);
    stop();
    const stopAgain = router.start();
    ready();
    await flush();
    expect(agents).toEqual([{ serverId: "host", agentId: "agent" }]);
    expect(source.launchReads).toBe(1);
    expect(source.acknowledged).toEqual(["one"]);
    source.tap(launch);
    source.tap({ id: "two", data: { serverId: "host", agentId: "second" } });
    source.tap({ id: "invalid", data: undefined });
    source.tap({
      id: "terminal",
      data: { serverId: "host", workspaceId: "ws", terminalId: "term" },
    });
    source.tap({ id: "host", data: { serverId: "host" } });
    await flush();
    expect(agents).toEqual([
      { serverId: "host", agentId: "agent" },
      { serverId: "host", agentId: "second" },
    ]);
    expect(routes).toEqual(["/h/host/workspace/ws?open=terminal%3Aterm", "/h/host"]);
    expect(source.acknowledged).toEqual(["one", "two", "invalid", "terminal", "host"]);
    stopAgain();
  });
});
