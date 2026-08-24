import { describe, expect, it } from "vitest";
import { TerminalServiceStore } from "./terminal-service-store.js";

describe("TerminalServiceStore", () => {
  it("attributes announcements to terminal and workspace, then updates health", () => {
    let now = new Date("2026-08-24T00:00:00.000Z");
    const store = new TerminalServiceStore({ now: () => now });
    const [candidate] = store.observeOutput(
      { terminalId: "term-1", workspaceId: "ws-1" },
      "VITE ready at http://localhost:5173\n",
    );
    expect(candidate).toMatchObject({
      workspaceId: "ws-1",
      terminalId: "term-1",
      lifecycle: "available",
      port: 5173,
      localUrl: "http://localhost:5173/",
    });

    now = new Date("2026-08-24T00:00:01.000Z");
    expect(store.setHealth(candidate!.id, true)).toMatchObject({
      lifecycle: "healthy",
      observedAt: now.toISOString(),
    });
  });

  it("deduplicates a terminal by port while accepting the latest URL", () => {
    const store = new TerminalServiceStore();
    const identity = { terminalId: "term-1", workspaceId: "ws-1" };
    const first = store.observeOutput(identity, "http://localhost:3000/one")[0];
    const second = store
      .observeOutput(identity, "\nhttp://127.0.0.1:3000/two")
      .find((candidate) => candidate.port === 3000);
    expect(second?.id).toBe(first?.id);
    expect(store.listForWorkspace("ws-1")).toHaveLength(1);
    expect(store.listForWorkspace("ws-1")[0]?.localUrl).toBe("http://127.0.0.1:3000/two");
  });

  it("clears every candidate and detector when its terminal exits", () => {
    const store = new TerminalServiceStore();
    const identity = { terminalId: "term-1", workspaceId: "ws-1" };
    store.observeOutput(identity, "http://localhost:3000 http://localhost:4000");
    expect(store.listForWorkspace("ws-1")).toHaveLength(2);
    expect(store.removeTerminal("term-1")).toHaveLength(2);
    expect(store.listForWorkspace("ws-1")).toEqual([]);
  });

  it("bounds candidates announced by one terminal", () => {
    const store = new TerminalServiceStore({ maxCandidatesPerTerminal: 2 });
    store.observeOutput(
      { terminalId: "term-1", workspaceId: "ws-1" },
      "http://localhost:3000 http://localhost:3001 http://localhost:3002",
    );
    expect(store.listForWorkspace("ws-1").map((candidate) => candidate.port)).toEqual([3000, 3001]);
  });
});
