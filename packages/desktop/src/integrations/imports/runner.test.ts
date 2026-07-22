import type { ImportResult, PaseoImportHost, RunImportOptions } from "@getpaseo/import";
import { expect, test } from "vitest";
import { DesktopImportRunner, type DesktopImportOutput, type ImportTarget } from "./runner.js";

const eligibleTarget: ImportTarget = {
  status: "running",
  desktopManaged: true,
  listen: "unix:///tmp/paseo.sock",
  home: "/tmp/paseo-home",
  appVersion: "0.1.110",
  daemonVersion: "0.1.110",
  passwordProtected: false,
};

test("calls the installed library and streams typed progress", async () => {
  const outputs: DesktopImportOutput[] = [];
  const host = createHost();
  const runner = createRunner({
    host,
    runImport: async (options) => {
      options.onEvent?.({ level: "info", message: "Found one project." });
      return emptyResult();
    },
  });

  const runId = await runner.run("source-fixture", (output) => outputs.push(output));
  await waitForCompletion(outputs);

  expect(outputs).toEqual([
    {
      runId,
      type: "event",
      event: { level: "info", message: "Found one project." },
    },
    { runId, type: "status", succeeded: true },
  ]);
  expect(host.closed).toBe(true);
});

test("allows only one import at a time", async () => {
  let finish: (() => void) | undefined;
  const runner = createRunner({
    runImport: () =>
      new Promise((resolve) => {
        finish = () => resolve(emptyResult());
      }),
  });

  await runner.run("source-fixture", () => undefined);
  await expect(runner.run("source-fixture", () => undefined)).rejects.toThrow(
    "An import is already running.",
  );
  finish?.();
  await waitUntil(() => runner.run("source-fixture", () => undefined));
});

test("reports library failures and closes the host", async () => {
  const outputs: DesktopImportOutput[] = [];
  const host = createHost();
  const runner = createRunner({
    host,
    runImport: async () => {
      throw new Error("Source database is unreadable.");
    },
  });

  const runId = await runner.run("source-fixture", (output) => outputs.push(output));
  await waitForCompletion(outputs);

  expect(outputs).toEqual([
    {
      runId,
      type: "event",
      event: { level: "error", message: "Source database is unreadable." },
    },
    { runId, type: "status", succeeded: false },
  ]);
  expect(host.closed).toBe(true);
});

test.each([
  [{ ...eligibleTarget, passwordProtected: true }, "password-protected"],
  [{ ...eligibleTarget, listen: "10.0.0.5:6767" }, "nonlocal-host"],
  [{ ...eligibleTarget, status: "stopped" as const }, "host-not-running"],
  [{ ...eligibleTarget, daemonVersion: "0.1.109" }, "host-version-mismatch"],
] as const)("returns a localizable availability reason", async (target, reason) => {
  const runner = createRunner({ target });

  await expect(runner.availability("source-fixture")).resolves.toEqual({
    available: false,
    reason,
  });
});

test.each(["[::1]:6767", "::1:6767"])("accepts local IPv6 listen address %s", async (listen) => {
  const runner = createRunner({ target: { ...eligibleTarget, listen } });

  await expect(runner.availability("source-fixture")).resolves.toEqual({
    available: true,
    reason: null,
  });
});

test("rejects an unregistered source before target lookup or connection", async () => {
  let targetRead = false;
  let connected = false;
  const runner = new DesktopImportRunner({
    sources: new Map(),
    getTarget: async () => {
      targetRead = true;
      return eligibleTarget;
    },
    connect: async () => {
      connected = true;
      return createHost();
    },
    runImport: async () => emptyResult(),
  });

  await expect(runner.run("unknown-source", () => undefined)).rejects.toThrow(
    "Unsupported import source: unknown-source",
  );
  expect(targetRead).toBe(false);
  expect(connected).toBe(false);
});

function createRunner(options: {
  target?: ImportTarget;
  host?: TestHost;
  runImport?: (options: RunImportOptions) => Promise<ImportResult>;
}): DesktopImportRunner {
  return new DesktopImportRunner({
    sources: new Map([["source-fixture", { kind: "conductor" }]]),
    getTarget: async () => options.target ?? eligibleTarget,
    connect: async () => options.host ?? createHost(),
    runImport: options.runImport ?? (async () => emptyResult()),
    createRunId: () => "run-1",
  });
}

interface TestHost extends PaseoImportHost {
  closed: boolean;
  close(): Promise<void>;
}

function createHost(): TestHost {
  return {
    closed: false,
    addProject: async () => undefined,
    openCheckout: async () => undefined,
    readProjectConfig: async () => ({ config: null, revision: null }),
    writeProjectConfig: async () => undefined,
    ensureCheckout: async () => ({ path: "", created: false }),
    async close() {
      this.closed = true;
    },
  };
}

function emptyResult() {
  return {
    inventory: { projects: [], skippedSettings: [] },
    notices: [],
  };
}

async function waitForCompletion(outputs: DesktopImportOutput[]): Promise<void> {
  await waitUntil(() => outputs.some((output) => output.type === "status"));
}

async function waitUntil<T>(read: () => T | Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      if (attempt === 19) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Expected import state was not reached.");
}
