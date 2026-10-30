import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ZCODE_NOT_FOUND_DIAGNOSTIC, resolveZCodeCommand } from "./binary.js";

describe("ZCode binary discovery", () => {
  test("reports every resolution path when nothing is found", async () => {
    const empty = await mkdtemp(join(tmpdir(), "zcode-bin-"));
    const result = await resolveZCodeCommand({
      pathEntries: [empty],
      env: {},
      desktopRoots: [join(empty, "no-such-app")],
    });
    expect(result).toBeUndefined();
    for (const hint of ["agents.providers.zcode.command", "PATH", "desktop", "GLM_BINARY_PATH"]) {
      expect(ZCODE_NOT_FOUND_DIAGNOSTIC).toContain(hint);
    }
  });

  test("prefers the desktop bundle over the environment variable", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bin-"));
    const bundleDir = join(root, "ZCode.app", "Contents", "Resources", "glm");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "zcode.cjs"), "// bundle\n");
    const fakeNode = join(root, "node");
    await writeFile(fakeNode, "#!/bin/sh\n", { mode: 0o755 });
    const result = await resolveZCodeCommand({
      pathEntries: [],
      env: { GLM_BINARY_PATH: join(root, "ignored") },
      desktopRoots: [join(root, "ZCode.app")],
      execPath: fakeNode,
    });
    expect(result?.[1]).toContain("zcode.cjs");
  });

  test("uses an executable named zcode found on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bin-"));
    const binary = join(root, "zcode");
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
    const result = await resolveZCodeCommand({
      pathEntries: [root],
      env: {},
      desktopRoots: [],
    });
    expect(result?.[0]).toBe(binary);
  });
});
