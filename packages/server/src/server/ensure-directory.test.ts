import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDirectory } from "./ensure-directory.js";

describe("ensureDirectory", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "paseo-ensure-directory-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("creates a missing nested directory", async () => {
    const nested = path.join(directory, "nested", "child");

    await ensureDirectory(nested);

    expect((await stat(nested)).isDirectory()).toBe(true);
  });

  test("leaves an existing directory in place", async () => {
    await expect(ensureDirectory(directory)).resolves.toBeUndefined();

    expect((await stat(directory)).isDirectory()).toBe(true);
  });

  // `mkdir(recursive: true)` throws EPERM for an existing drive root on Windows.
  test.runIf(process.platform === "win32")("accepts an existing filesystem root", async () => {
    await expect(ensureDirectory(path.parse(process.cwd()).root)).resolves.toBeUndefined();
  });
});
