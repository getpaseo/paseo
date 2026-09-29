import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { startCodexAppServer } from "./startup.js";
import { runProviderRefreshWithDeadline } from "../../provider-refresh-deadline.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function client() {
  return {
    request: vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({})),
    notify: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}

test("aliases sharing a state directory serialize initialization but keep initialized clients alive", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-startup-"));
  const alias = `${home}-alias`;
  await symlink(home, alias, "junction");
  const started = deferred();
  const allowed = deferred();
  const firstClient = client();
  const secondClient = client();
  const spawned: string[] = [];
  firstClient.request.mockImplementation(async () => {
    started.resolve();
    await allowed.promise;
    return {};
  });
  const first = startCodexAppServer({
    stateDirectory: home,
    initializeParams: {},
    createClient: async () => {
      spawned.push("first");
      return firstClient;
    },
  });
  try {
    await started.promise;
    const second = startCodexAppServer({
      stateDirectory: alias,
      initializeParams: {},
      createClient: async () => {
        spawned.push("second");
        return secondClient;
      },
    });
    await Promise.resolve();
    expect(spawned).toEqual(["first"]);
    allowed.resolve();
    expect(await Promise.all([first, second])).toEqual([firstClient, secondClient]);
    expect(spawned).toEqual(["first", "second"]);
    expect(firstClient.dispose).not.toHaveBeenCalled();
    expect(secondClient.dispose).not.toHaveBeenCalled();
    expect(firstClient.notify).toHaveBeenCalledWith("initialized", {});
  } finally {
    allowed.resolve();
    await first;
    await rm(alias);
    await rm(home, { recursive: true });
  }
});

test("another state directory can initialize while the first is blocked", async () => {
  const started = deferred();
  const allowed = deferred();
  const firstClient = client();
  firstClient.request.mockImplementation(async () => {
    started.resolve();
    await allowed.promise;
    return {};
  });
  const first = startCodexAppServer({
    stateDirectory: "/tmp/codex-startup-a",
    initializeParams: {},
    createClient: async () => firstClient,
  });
  try {
    await started.promise;
    const other = client();
    await expect(
      startCodexAppServer({
        stateDirectory: "/tmp/codex-startup-b",
        initializeParams: {},
        createClient: async () => other,
      }),
    ).resolves.toBe(other);
  } finally {
    allowed.resolve();
    await first;
  }
});

test("failed initialization holds its lane through disposal and allows a retry", async () => {
  const disposing = deferred();
  const allowed = deferred();
  const firstClient = client();
  firstClient.request.mockRejectedValue(new Error("initialize failed"));
  firstClient.dispose.mockImplementation(async () => {
    disposing.resolve();
    await allowed.promise;
  });
  const nextClient = client();
  const spawnNext = vi.fn(async () => nextClient);
  const first = startCodexAppServer({
    stateDirectory: "/tmp/codex-startup-failure",
    initializeParams: {},
    createClient: async () => firstClient,
  });
  const rejected = expect(first).rejects.toThrow("initialize failed");
  await disposing.promise;
  const next = startCodexAppServer({
    stateDirectory: "/tmp/codex-startup-failure",
    initializeParams: {},
    createClient: spawnNext,
  });
  await Promise.resolve();
  expect(spawnNext).not.toHaveBeenCalled();
  allowed.resolve();
  await rejected;
  await expect(next).resolves.toBe(nextClient);
  expect(firstClient.dispose).toHaveBeenCalledOnce();
  expect(spawnNext).toHaveBeenCalledOnce();
});

test("aborting initialization disposes the client and permits later startup", async () => {
  vi.useFakeTimers();
  const started = deferred();
  const firstClient = client();
  firstClient.request.mockImplementation(async () => {
    started.resolve();
    return await new Promise<never>(() => {});
  });
  const first = runProviderRefreshWithDeadline({
    label: "Codex",
    timeoutMs: 100,
    operation: (context) =>
      startCodexAppServer({
        stateDirectory: "/tmp/codex-startup-abort",
        initializeParams: {},
        context,
        createClient: async () => firstClient,
      }),
  });
  const rejected = expect(first).rejects.toThrow("Timed out refreshing Codex after 100ms");
  try {
    await started.promise;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(firstClient.dispose).toHaveBeenCalledOnce();
    const next = client();
    await expect(
      startCodexAppServer({
        stateDirectory: "/tmp/codex-startup-abort",
        initializeParams: {},
        createClient: async () => next,
      }),
    ).resolves.toBe(next);
  } finally {
    vi.useRealTimers();
  }
});
