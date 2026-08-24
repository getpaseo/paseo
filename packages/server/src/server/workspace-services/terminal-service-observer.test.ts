import { describe, expect, it, vi } from "vitest";
import type {
  TerminalExitListener,
  TerminalManager,
  TerminalOutputListener,
} from "../../terminal/terminal-manager.js";
import { observeTerminalServices, probeLocalService } from "./terminal-service-observer.js";

function managerHarness() {
  let output: TerminalOutputListener | null = null;
  let exit: TerminalExitListener | null = null;
  const manager = {
    subscribeTerminalOutput(listener: TerminalOutputListener) {
      output = listener;
      return () => {
        output = null;
      };
    },
    subscribeTerminalExit(listener: TerminalExitListener) {
      exit = listener;
      return () => {
        exit = null;
      };
    },
  } as TerminalManager;
  return {
    manager,
    emitOutput(data: string) {
      output?.({ terminalId: "term-1", workspaceId: "ws-1", cwd: "/repo", data });
    },
    emitExit() {
      exit?.({ terminalId: "term-1", workspaceId: "ws-1", cwd: "/repo" });
    },
    hasListeners: () => output !== null && exit !== null,
  };
}

describe("probeLocalService", () => {
  it("treats reachable non-server-error responses as healthy", async () => {
    const fetchApi = vi.fn(async () => new Response("", { status: 404 }));
    await expect(probeLocalService("http://localhost:3000", { fetch: fetchApi })).resolves.toBe(
      true,
    );
    expect(fetchApi).toHaveBeenCalledWith(
      "http://localhost:3000",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("marks failures and server errors unhealthy", async () => {
    await expect(
      probeLocalService("http://localhost:3000", {
        fetch: async () => new Response("", { status: 503 }),
      }),
    ).resolves.toBe(false);
    await expect(
      probeLocalService("http://localhost:3000", {
        fetch: async () => Promise.reject(new Error("offline")),
      }),
    ).resolves.toBe(false);
  });
});

describe("observeTerminalServices", () => {
  it("publishes available, healthy, and removed inventory states", async () => {
    const harness = managerHarness();
    let resolveProbe!: (healthy: boolean) => void;
    const probe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const onChange = vi.fn();
    const observer = observeTerminalServices({
      terminalManager: harness.manager,
      probe,
      onChange,
    });

    harness.emitOutput("ready at http://localhost:5173");
    expect(observer.store.listForWorkspace("ws-1")).toMatchObject([
      { lifecycle: "available", port: 5173 },
    ]);
    expect(onChange).toHaveBeenCalledWith("ws-1");

    resolveProbe(true);
    await vi.waitFor(() =>
      expect(observer.store.listForWorkspace("ws-1")[0]?.lifecycle).toBe("healthy"),
    );

    harness.emitExit();
    expect(observer.store.listForWorkspace("ws-1")).toEqual([]);
    observer.dispose();
    expect(harness.hasListeners()).toBe(false);
  });

  it("ignores a late health result after terminal exit", async () => {
    const harness = managerHarness();
    let resolveProbe!: (healthy: boolean) => void;
    const observer = observeTerminalServices({
      terminalManager: harness.manager,
      probe: () => new Promise((resolve) => (resolveProbe = resolve)),
      onChange: vi.fn(),
    });
    harness.emitOutput("http://localhost:3000");
    harness.emitExit();
    resolveProbe(true);
    await Promise.resolve();
    expect(observer.store.listForWorkspace("ws-1")).toEqual([]);
  });

  it("retries an initially unavailable URL until the service becomes healthy", async () => {
    vi.useFakeTimers();
    const harness = managerHarness();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const observer = observeTerminalServices({
      terminalManager: harness.manager,
      probe,
      probeRetryDelayMs: 25,
      onChange: vi.fn(),
    });
    harness.emitOutput("http://localhost:4173");
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.store.listForWorkspace("ws-1")[0]?.lifecycle).toBe("unhealthy");
    await vi.advanceTimersByTimeAsync(25);
    expect(observer.store.listForWorkspace("ws-1")[0]?.lifecycle).toBe("healthy");
    expect(probe).toHaveBeenCalledTimes(2);
    observer.dispose();
    vi.useRealTimers();
  });
});
