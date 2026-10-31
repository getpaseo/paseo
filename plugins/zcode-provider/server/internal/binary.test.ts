import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ZCODE_NOT_FOUND_DIAGNOSTIC, resolveZCodeCommand, resolveZCodeLaunch } from "./binary.js";

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

  test("finds the desktop bundle in the Windows layout", async () => {
    // The Windows app keeps the runtime under <app>/resources/glm, without the
    // macOS Contents/ directory.
    const root = await mkdtemp(join(tmpdir(), "zcode-bin-"));
    const bundleDir = join(root, "ZCode", "resources", "glm");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "zcode.cjs"), "// bundle\n");
    const fakeNode = join(root, "node");
    await writeFile(fakeNode, "#!/bin/sh\n", { mode: 0o755 });
    const result = await resolveZCodeCommand({
      pathEntries: [],
      env: {},
      desktopRoots: [join(root, "ZCode")],
      execPath: fakeNode,
    });
    expect(result?.[0]).toBe(fakeNode);
    expect(result?.[1]).toContain(join("resources", "glm", "zcode.cjs"));
  });

  test("passes the built-in provider config to the bundled runtime", async () => {
    // The app keeps the built-in provider config under <app>/resources/config,
    // outside the glm/ directory the runtime lives in. The runtime only looks
    // next to its own entrypoint, so without this it exits before answering.
    const root = await mkdtemp(join(tmpdir(), "zcode-bin-"));
    const bundleDir = join(root, "ZCode", "resources", "glm");
    const configDir = join(root, "ZCode", "resources", "config", "provider");
    await mkdir(bundleDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(bundleDir, "zcode.cjs"), "// bundle\n");
    const configPath = join(configDir, "zcode-builtin.json");
    await writeFile(configPath, "{}\n");
    const fakeNode = join(root, "node");
    await writeFile(fakeNode, "#!/bin/sh\n", { mode: 0o755 });

    const launch = await resolveZCodeLaunch({
      pathEntries: [],
      env: {},
      desktopRoots: [join(root, "ZCode")],
      execPath: fakeNode,
    });

    expect(launch?.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(launch?.env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]).toBe(configPath);
  });

  test("omits the provider config when the runtime has none", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bin-"));
    const bundleDir = join(root, "ZCode", "resources", "glm");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "zcode.cjs"), "// bundle\n");
    const fakeNode = join(root, "node");
    await writeFile(fakeNode, "#!/bin/sh\n", { mode: 0o755 });

    const launch = await resolveZCodeLaunch({
      pathEntries: [],
      env: {},
      desktopRoots: [join(root, "ZCode")],
      execPath: fakeNode,
    });

    expect(launch?.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(launch?.env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]).toBeUndefined();
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
