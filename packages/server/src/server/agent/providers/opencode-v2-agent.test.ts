import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { OpenCodeV2AgentClient } from "./opencode-v2-agent.js";

const originalEnv = {
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
};
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isolatePathTo(dir: string): void {
  process.env.PATH = dir;
  if (process.platform === "win32") {
    process.env.PATHEXT = ".CMD";
  }
}

function installFakeBinary(dir: string, name = "opencode2"): string {
  const binPath = join(dir, name);
  copyFileSync(process.execPath, binPath);
  return binPath;
}

afterEach(() => {
  process.env.PATH = originalEnv.PATH;
  process.env.PATHEXT = originalEnv.PATHEXT;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeClient(runtimeSettings?: ProviderRuntimeSettings): OpenCodeV2AgentClient {
  return new OpenCodeV2AgentClient(createTestLogger(), runtimeSettings);
}

describe("OpenCodeV2AgentClient availability", () => {
  test("reports unavailable when opencode2 is not on PATH", async () => {
    const binDir = makeTempDir("opencode-v2-availability-missing-");
    isolatePathTo(binDir);
    await expect(makeClient().isAvailable()).resolves.toBe(false);
  });

  test("reports available when opencode2 is on PATH", async () => {
    const binDir = makeTempDir("opencode-v2-availability-present-");
    installFakeBinary(binDir);
    isolatePathTo(binDir);
    await expect(makeClient().isAvailable()).resolves.toBe(true);
  });

  test("reports unavailable when the command override points at a missing path", async () => {
    const client = makeClient({
      command: { mode: "replace", argv: ["/definitely/not/opencode2"] },
    });
    await expect(client.isAvailable()).resolves.toBe(false);
  });

  test("reports available when the command override resolves", async () => {
    const binDir = makeTempDir("opencode-v2-availability-override-");
    const binPath = installFakeBinary(binDir);
    const client = makeClient({
      command: { mode: "replace", argv: [binPath] },
    });
    await expect(client.isAvailable()).resolves.toBe(true);
  });
});

describe("OpenCodeV2AgentClient diagnostic", () => {
  test("reports the binary found without crashing when opencode2 is present", async () => {
    const binDir = makeTempDir("opencode-v2-diagnostic-present-");
    installFakeBinary(binDir);
    isolatePathTo(binDir);

    const { diagnostic } = await makeClient().getDiagnostic();
    expect(diagnostic).toContain("OpenCode 2");
    expect(diagnostic).toContain("Binary");
    expect(diagnostic).toContain("Resolved path");
    expect(diagnostic).toContain("Auth");
  });

  test("reports the binary missing without crashing when opencode2 is absent", async () => {
    const binDir = makeTempDir("opencode-v2-diagnostic-missing-");
    isolatePathTo(binDir);

    const { diagnostic } = await makeClient().getDiagnostic();
    expect(diagnostic).toContain("OpenCode 2");
    expect(diagnostic).toContain("not found");
  });

  test("reports an override command in the diagnostic", async () => {
    const binDir = makeTempDir("opencode-v2-diagnostic-override-");
    const binPath = installFakeBinary(binDir);
    const client = makeClient({
      command: { mode: "replace", argv: [binPath] },
    });

    const { diagnostic } = await client.getDiagnostic();
    expect(diagnostic).toContain(binPath);
  });
});
