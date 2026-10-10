import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_FORGE_SERVICE_METHODS } from "@getpaseo/plugin/server";
import { createPluginForgeServiceProxy } from "./forge-service-proxy.js";

function createDescriptor(methods = [...PLUGIN_FORGE_SERVICE_METHODS]) {
  return {
    definition: {
      id: "acme",
      displayName: "Acme Forge",
      changeRequestAbbrev: "CR",
      changeRequestNoun: "change request",
      changeRequestNumberPrefix: "!",
      issueNumberPrefix: "#",
      signIn: null,
    },
    methods,
    authProbeCanThrow: true,
    supportsCrossRepoCheckoutWithoutRefs: false,
    hasProbeHost: true,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createPluginForgeServiceProxy", () => {
  it("exposes only declared optional helpers and forwards host probes", async () => {
    const invokeForge = vi.fn(async (_pluginId, _providerId, method, input) => {
      if (method === "probeHost") return input === "forge.example.com";
      if (method === "defaultCheckoutRefs") {
        return [{ remoteRef: "refs/changes/7/head" }];
      }
      return undefined;
    });
    const proxy = createPluginForgeServiceProxy({
      pluginId: "plugin",
      descriptor: createDescriptor(
        PLUGIN_FORGE_SERVICE_METHODS.filter((method) => method !== "buildPrLocalBranchName"),
      ),
      invoker: { invokeForge },
      logger: pino({ level: "silent" }),
    });

    expect(proxy.service.buildPrLocalBranchName).toBeUndefined();
    await expect(
      proxy.service.defaultCheckoutRefs?.({ changeRequestNumber: 7, headRef: "feature" }),
    ).resolves.toEqual([{ remoteRef: "refs/changes/7/head" }]);
    await expect(proxy.probeHost?.("forge.example.com")).resolves.toBe(true);
  });

  it("waits for queued invalidation before the next cwd request", async () => {
    let releaseInvalidation = () => undefined;
    let markInvalidationStarted = () => undefined;
    const invalidation = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });
    const invalidationStarted = new Promise<void>((resolve) => {
      markInvalidationStarted = resolve;
    });
    const events: string[] = [];
    const invokeForge = vi.fn(async (_pluginId, _providerId, method) => {
      events.push(`start:${method}`);
      if (method === "invalidate") {
        markInvalidationStarted();
        await invalidation;
      }
      events.push(`finish:${method}`);
      return method === "isAuthenticated" ? true : undefined;
    });
    const proxy = createPluginForgeServiceProxy({
      pluginId: "plugin",
      descriptor: createDescriptor(),
      invoker: { invokeForge },
      logger: pino({ level: "silent" }),
    });

    proxy.service.invalidate({ cwd: "/repo" });
    const authenticated = proxy.service.isAuthenticated({ cwd: "/repo" });
    await invalidationStarted;
    expect(events).toEqual(["start:invalidate"]);

    releaseInvalidation();
    await expect(authenticated).resolves.toBe(true);
    expect(events).toEqual([
      "start:invalidate",
      "finish:invalidate",
      "start:isAuthenticated",
      "finish:isAuthenticated",
    ]);
  });

  it("waits for a replacement invalidation tail before invoking a queued read", async () => {
    const firstInvalidation = createDeferred<void>();
    const secondInvalidation = createDeferred<void>();
    const firstStarted = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const events: string[] = [];
    let invalidationAttempt = 0;
    const invokeForge = vi.fn(async (_pluginId, _providerId, method) => {
      if (method === "invalidate") {
        invalidationAttempt += 1;
        const attempt = invalidationAttempt;
        events.push(`start:invalidate:${attempt}`);
        if (attempt === 1) {
          firstStarted.resolve();
          await firstInvalidation.promise;
        } else {
          secondStarted.resolve();
          await secondInvalidation.promise;
        }
        events.push(`finish:invalidate:${attempt}`);
        return undefined;
      }
      events.push(`invoke:${method}`);
      return method === "isAuthenticated";
    });
    const proxy = createPluginForgeServiceProxy({
      pluginId: "plugin",
      descriptor: createDescriptor(),
      invoker: { invokeForge },
      logger: pino({ level: "silent" }),
    });

    proxy.service.invalidate({ cwd: "/repo" });
    await firstStarted.promise;
    const authenticated = proxy.service.isAuthenticated({ cwd: "/repo" });
    proxy.service.invalidate({ cwd: "/repo" });

    firstInvalidation.resolve();
    await secondStarted.promise;
    expect(events).toEqual(["start:invalidate:1", "finish:invalidate:1", "start:invalidate:2"]);

    secondInvalidation.resolve();
    await expect(authenticated).resolves.toBe(true);
    expect(events).toEqual([
      "start:invalidate:1",
      "finish:invalidate:1",
      "start:invalidate:2",
      "finish:invalidate:2",
      "invoke:isAuthenticated",
    ]);
  });

  it("rejects a queued read when the replacement invalidation tail fails", async () => {
    const firstInvalidation = createDeferred<void>();
    const secondInvalidation = createDeferred<void>();
    const firstStarted = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    let invalidationAttempt = 0;
    const invokeForge = vi.fn(async (_pluginId, _providerId, method) => {
      if (method === "invalidate") {
        invalidationAttempt += 1;
        if (invalidationAttempt === 1) {
          firstStarted.resolve();
          await firstInvalidation.promise;
        } else {
          secondStarted.resolve();
          await secondInvalidation.promise;
        }
        return undefined;
      }
      return method === "isAuthenticated";
    });
    const proxy = createPluginForgeServiceProxy({
      pluginId: "plugin",
      descriptor: createDescriptor(),
      invoker: { invokeForge },
      logger: pino({ level: "silent" }),
    });

    proxy.service.invalidate({ cwd: "/repo" });
    await firstStarted.promise;
    const authenticated = proxy.service.isAuthenticated({ cwd: "/repo" });
    proxy.service.invalidate({ cwd: "/repo" });

    firstInvalidation.resolve();
    await secondStarted.promise;
    secondInvalidation.reject(new Error("replacement invalidation failed"));

    await expect(authenticated).rejects.toThrow("replacement invalidation failed");
    expect(invokeForge.mock.calls.map(([, , method]) => method)).toEqual([
      "invalidate",
      "invalidate",
    ]);
  });

  it("fails closed after invalidation fails and recovers after a successful retry", async () => {
    let invalidationAttempt = 0;
    const invokeForge = vi.fn(async (_pluginId, _providerId, method) => {
      if (method === "invalidate") {
        invalidationAttempt += 1;
        if (invalidationAttempt === 1) {
          throw new Error("cache invalidation failed");
        }
        return undefined;
      }
      if (method === "getCurrentPullRequestStatus") return null;
      if (method === "searchIssuesAndPrs") {
        return { items: [], featuresEnabled: true, authState: "authenticated" };
      }
      if (method === "getCheckDetails") {
        return { checkRunId: 1, name: "checks", annotations: [], failedJobs: [], truncated: false };
      }
      return undefined;
    });
    const proxy = createPluginForgeServiceProxy({
      pluginId: "plugin",
      descriptor: createDescriptor(),
      invoker: { invokeForge },
      logger: pino({ level: "silent" }),
    });

    proxy.service.invalidate({ cwd: "/repo" });
    await expect(
      proxy.service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature" }),
    ).rejects.toThrow("cache invalidation failed");
    await expect(
      proxy.service.searchIssuesAndPrs({
        cwd: "/repo",
        query: "change",
        kinds: ["change_request"],
      }),
    ).rejects.toThrow("cache invalidation failed");
    await expect(proxy.service.getCheckDetails({ cwd: "/repo", checkRunId: 1 })).rejects.toThrow(
      "cache invalidation failed",
    );
    expect(invokeForge.mock.calls.map(([, , method]) => method)).toEqual(["invalidate"]);

    proxy.service.invalidate({ cwd: "/repo" });
    await expect(
      proxy.service.searchIssuesAndPrs({
        cwd: "/repo",
        query: "change",
        kinds: ["change_request"],
      }),
    ).resolves.toMatchObject({ authState: "authenticated" });
    expect(invokeForge.mock.calls.map(([, , method]) => method)).toEqual([
      "invalidate",
      "invalidate",
      "searchIssuesAndPrs",
    ]);
  });
});
