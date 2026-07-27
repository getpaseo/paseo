import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ContainerProbeCoordinator } from "./container-probe-coordinator.js";
import type {
  ContainerBackend,
  ContainerRef,
  ContainerStopOptions,
  ContainerUpOptions,
  ExecutionHandle,
} from "./container-backend.js";
import { LocalLaunchStrategy } from "./launch-strategy.js";
import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";

const HANDLE: ExecutionHandle = {
  identifier: "container-1",
  remoteUser: "root",
  remoteWorkspaceFolder: "/workspaces/app",
};

const READY_ENTRY: ProviderSnapshotEntry = {
  provider: "claude",
  status: "ready",
  enabled: true,
  models: [{ id: "opus", name: "Opus" }],
};

interface BackendCalls {
  up: ContainerUpOptions[];
  stopped: Array<{ ref: ContainerRef; options?: ContainerStopOptions }>;
}

function createFakeBackend(
  options: {
    up?: (options: ContainerUpOptions) => Promise<ExecutionHandle>;
  } = {},
): { backend: ContainerBackend; calls: BackendCalls } {
  const calls: BackendCalls = { up: [], stopped: [] };
  const backend = {
    id: "devcontainer",
    label: "Dev Container",
    isAvailable: async () => true,
    hasConfig: () => true,
    async up(upOptions: ContainerUpOptions) {
      calls.up.push(upOptions);
      return options.up ? options.up(upOptions) : HANDLE;
    },
    async stop(ref: ContainerRef, stopOptions?: ContainerStopOptions) {
      calls.stopped.push({ ref, ...(stopOptions ? { options: stopOptions } : {}) });
    },
    getHandle: () => null,
    getContainerInfo: async () => null,
    restart: async () => HANDLE,
    rebuild: async () => HANDLE,
    getConfigHash: () => "hash",
    isAlreadyRunning: async () => false,
    removeAbandonedProbeContainers: async () => 0,
    createStrategy: () => new LocalLaunchStrategy(),
  } satisfies ContainerBackend;
  return { backend, calls };
}

function createCoordinator(input: {
  backend: ContainerBackend;
  probeProviders?: () => Promise<ProviderSnapshotEntry[]>;
}): ContainerProbeCoordinator {
  return new ContainerProbeCoordinator({
    logger: createTestLogger(),
    resolveBackend: (id) => (id === input.backend.id ? input.backend : null),
    probeProviders: input.probeProviders ?? (async () => [READY_ENTRY]),
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("a probe returns the entries it found and removes its container", async () => {
  const { backend, calls } = createFakeBackend();
  const coordinator = createCoordinator({ backend });

  const result = await coordinator.probe({
    requestId: "req-1",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });

  expect(result.status).toBe("success");
  expect(result.entries).toEqual([READY_ENTRY]);
  // The probe container is scratch: it must not survive the answer.
  expect(calls.stopped).toHaveLength(1);
  expect(calls.stopped[0].options).toEqual({ remove: true });
});

test("a probe container is created under its own identity, never a workspace's", async () => {
  const { backend, calls } = createFakeBackend();
  const coordinator = createCoordinator({ backend });

  await coordinator.probe({
    requestId: "req-1",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });
  await coordinator.probe({
    requestId: "req-2",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });

  const [first, second] = calls.up;
  expect(first.kind).toBe("probe");
  expect(first.key.startsWith("probe:")).toBe(true);
  // Two probes of the same directory are two containers, so tearing one down
  // can never take the other — or a workspace's — with it.
  expect(second.key).not.toBe(first.key);
});

test("progress lines reach every waiter", async () => {
  const gate = deferred<ExecutionHandle>();
  const { backend } = createFakeBackend({
    up: async (options) => {
      options.onProgress?.("Pulling image...");
      return gate.promise;
    },
  });
  const coordinator = createCoordinator({ backend });
  const firstLines: string[] = [];
  const secondLines: string[] = [];

  const first = coordinator.probe({
    requestId: "req-1",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: (line) => firstLines.push(line),
  });
  const second = coordinator.probe({
    requestId: "req-2",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: (line) => secondLines.push(line),
  });
  gate.resolve(HANDLE);
  await Promise.all([first, second]);

  expect(firstLines).toContain("Pulling image...");
});

test("an identical probe joins the running one instead of building a second container", async () => {
  const gate = deferred<ExecutionHandle>();
  const { backend, calls } = createFakeBackend({ up: () => gate.promise });
  const coordinator = createCoordinator({ backend });

  const first = coordinator.probe({
    requestId: "req-1",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });
  const second = coordinator.probe({
    requestId: "req-2",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });
  gate.resolve(HANDLE);
  const [firstResult, secondResult] = await Promise.all([first, second]);

  expect(calls.up).toHaveLength(1);
  expect(firstResult.entries).toEqual([READY_ENTRY]);
  expect(secondResult.entries).toEqual([READY_ENTRY]);
});

test("probing a different backend for the same directory supersedes the running probe", async () => {
  const gate = deferred<ExecutionHandle>();
  const { backend, calls } = createFakeBackend({
    up: (options) =>
      options.kind === "probe" && calls.up.length === 1 ? gate.promise : Promise.resolve(HANDLE),
  });
  const coordinator = new ContainerProbeCoordinator({
    logger: createTestLogger(),
    resolveBackend: () => backend,
    probeProviders: async () => [READY_ENTRY],
  });

  const superseded = coordinator.probe({
    requestId: "req-1",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });
  const current = coordinator.probe({
    requestId: "req-2",
    cwd: "/repo/app",
    containerBackend: "podman",
    onProgress: () => {},
  });

  // The abandoned answer resolves as cancelled rather than hanging or erroring.
  gate.resolve(HANDLE);
  expect((await superseded).status).toBe("cancelled");
  expect((await current).status).toBe("success");
});

test("cancelling the last waiter stops the probe, an earlier one does not", async () => {
  const gate = deferred<ExecutionHandle>();
  const { backend } = createFakeBackend({ up: () => gate.promise });
  const coordinator = createCoordinator({ backend });

  const first = coordinator.probe({
    requestId: "req-1",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });
  const second = coordinator.probe({
    requestId: "req-2",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });

  // One client walking away must not cut the other one off.
  coordinator.cancelByRequestId("req-1");
  gate.resolve(HANDLE);
  expect((await second).status).toBe("success");
  await first;

  const solo = coordinator.probe({
    requestId: "req-3",
    cwd: "/repo/other",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });
  coordinator.cancelByRequestId("req-3");
  expect((await solo).status).toBe("cancelled");
});

test("disposing the session cancels its probes and removes their containers", async () => {
  const gate = deferred<ExecutionHandle>();
  const { backend, calls } = createFakeBackend({ up: () => gate.promise });
  const coordinator = createCoordinator({ backend });

  const pending = coordinator.probe({
    requestId: "req-1",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });
  coordinator.dispose();
  gate.resolve(HANDLE);

  expect((await pending).status).toBe("cancelled");
  expect(calls.stopped[0].options).toEqual({ remove: true });
});

test("an unknown backend fails the probe without starting anything", async () => {
  const { backend, calls } = createFakeBackend();
  const coordinator = createCoordinator({ backend });

  const result = await coordinator.probe({
    requestId: "req-1",
    cwd: "/repo/app",
    containerBackend: "not-a-backend",
    onProgress: () => {},
  });

  expect(result.status).toBe("error");
  expect(result.error).toContain("not-a-backend");
  expect(calls.up).toHaveLength(0);
});

test("a container that fails to start is reported and cleaned up", async () => {
  const { backend, calls } = createFakeBackend({
    up: async () => {
      throw new Error("devcontainer up failed: no space left on device");
    },
  });
  const coordinator = createCoordinator({ backend });

  const result = await coordinator.probe({
    requestId: "req-1",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });

  expect(result.status).toBe("error");
  expect(result.error).toContain("no space left on device");
  // A half-built container is still a container.
  expect(calls.stopped[0].options).toEqual({ remove: true });
});

test("provider probing runs inside the probe container", async () => {
  const { backend } = createFakeBackend();
  const probeProviders = vi.fn(async () => [READY_ENTRY]);
  const coordinator = new ContainerProbeCoordinator({
    logger: createTestLogger(),
    resolveBackend: () => backend,
    probeProviders,
  });

  await coordinator.probe({
    requestId: "req-1",
    cwd: "/repo/app",
    containerBackend: "devcontainer",
    onProgress: () => {},
  });

  expect(probeProviders).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: "/repo/app", launchStrategy: expect.anything() }),
  );
});
