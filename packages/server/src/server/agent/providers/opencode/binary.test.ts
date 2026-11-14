import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveInstalledOpenCodeBinary } from "./binary.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-binary-"));
  tempDirs.push(dir);
  return dir;
}

function write(filePath: string, contents = ""): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

describe.skipIf(process.platform === "win32")("resolveInstalledOpenCodeBinary", () => {
  test("spawns the cached native binary instead of the npm wrapper", async () => {
    const root = tempDir();
    const script = path.join(root, "lib/node_modules/opencode-ai/bin/opencode");
    const native = path.join(root, "lib/node_modules/opencode-ai/bin/.opencode");
    const shim = path.join(root, "bin/opencode");
    write(script, "#!/usr/bin/env node\n");
    write(native, "native");
    mkdirSync(path.dirname(shim), { recursive: true });
    symlinkSync(script, shim);

    await expect(resolveInstalledOpenCodeBinary(shim)).resolves.toBe(await realpath(native));
  });

  test("spawns the platform package when the wrapper has not cached a binary", async () => {
    const root = tempDir();
    const script = path.join(root, "lib/node_modules/opencode-ai/bin/opencode");
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const packed = path.join(
      root,
      `lib/node_modules/opencode-${platform}-${process.arch}/bin/opencode`,
    );
    write(script, "#!/usr/bin/env node\n");
    write(packed, "native");

    await expect(resolveInstalledOpenCodeBinary(script)).resolves.toBe(await realpath(packed));
  });

  test("keeps a native opencode executable that is not a wrapper", async () => {
    const root = tempDir();
    const binary = path.join(root, "opencode");
    write(binary, "native");

    await expect(resolveInstalledOpenCodeBinary(binary)).resolves.toBe(binary);
  });

  test("warns when a wrapper's native binary cannot be resolved", async () => {
    const root = tempDir();
    const script = path.join(root, "opencode");
    write(script, "#!/usr/bin/env node\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(resolveInstalledOpenCodeBinary(script)).resolves.toBe(script);
    expect(warn).toHaveBeenCalledOnce();
  });
});
