import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "./node-entrypoint-runner";

declare global {
  // eslint-disable-next-line no-var
  var __PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__:
    | {
        argv: string[];
        electronRunAsNode: string | undefined;
        electronNoAttachConsole: string | undefined;
      }
    | undefined;
}

describe("node-entrypoint-runner", () => {
  it("initializes enhanced CLI configuration before the first CLI entrypoint runs", async () => {
    const originalArgv = process.argv;
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "paseo-enhanced-cli-home-"));
    const fixturePath = path.join(fixtureDir, "fixture.mjs");
    writeFileSync(fixturePath, "export {};\n");
    vi.stubEnv("PASEO_HOME", fixtureDir);
    vi.stubEnv("PASEO_DEEP_LINK_SCHEME", "paseo-enhanced");
    process.argv = ["Paseo Enhanced", "runner", "node-script", fixturePath, "daemon", "status"];
    try {
      await main();
      expect(JSON.parse(readFileSync(path.join(fixtureDir, "config.json"), "utf8"))).toEqual({
        daemon: { listen: "127.0.0.1:6791" },
      });
    } finally {
      process.argv = originalArgv;
      vi.unstubAllEnvs();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
  it("preserves Electron node-mode env before loading the target entrypoint", async () => {
    const originalArgv = process.argv;
    const originalRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const originalNoAttachConsole = process.env.ELECTRON_NO_ATTACH_CONSOLE;
    const originalFixture = globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__;
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "paseo-node-entrypoint-runner-"));
    const fixturePath = path.join(fixtureDir, "fixture.mjs");
    writeFileSync(
      fixturePath,
      `
globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__ = {
  argv: process.argv,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
  electronNoAttachConsole: process.env.ELECTRON_NO_ATTACH_CONSOLE,
};
`,
    );

    process.argv = ["Paseo", "runner", "node-script", fixturePath, "daemon", "start"];
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
    delete globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__;

    try {
      await main();

      expect(globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__).toEqual({
        argv: ["Paseo", fixturePath, "daemon", "start"],
        electronRunAsNode: "1",
        electronNoAttachConsole: "1",
      });
    } finally {
      process.argv = originalArgv;
      if (originalRunAsNode === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE;
      } else {
        process.env.ELECTRON_RUN_AS_NODE = originalRunAsNode;
      }
      if (originalNoAttachConsole === undefined) {
        delete process.env.ELECTRON_NO_ATTACH_CONSOLE;
      } else {
        process.env.ELECTRON_NO_ATTACH_CONSOLE = originalNoAttachConsole;
      }
      globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__ = originalFixture;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
