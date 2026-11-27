import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { materializeProviderImage } from "./provider-image-output.js";

describe.skipIf(process.platform === "win32")("materializeProviderImage", () => {
  test("writes image attachments under a private temp directory", async () => {
    const materialized = await materializeProviderImage({
      data: "YWJjMTIz",
      mimeType: "image/png",
    });
    const attachmentDir = path.dirname(materialized.path);

    try {
      expect(path.basename(attachmentDir)).toMatch(/^paseo-attachments-/);
      expect(existsSync(materialized.path)).toBe(true);
      expect(statSync(attachmentDir).mode & 0o777).toBe(0o700);
      expect(statSync(materialized.path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(attachmentDir, { recursive: true, force: true });
    }
  });
});

test.skipIf(process.platform === "win32")(
  "replaces a cached attachment directory turned into a symlink",
  async () => {
    const image = { data: "c3ltbGluayByZWdyZXNzaW9u", mimeType: "image/png" };
    const first = await materializeProviderImage(image);
    const dir = path.dirname(first.path);
    const target = mkdtempSync(path.join(os.tmpdir(), "paseo-image-symlink-test-"));
    let replacement: string | undefined;
    try {
      rmSync(dir, { recursive: true });
      // Populate the target to exercise validation before accepting a cache hit.
      writeFileSync(path.join(target, path.basename(first.path)), "symlink target");
      symlinkSync(target, dir, "dir");

      const second = await materializeProviderImage(image);
      replacement = path.dirname(second.path);
      expect(replacement).not.toBe(dir);
      expect(path.basename(replacement)).toMatch(/^paseo-attachments-/);
      expect(readFileSync(second.path, "utf8")).toBe("symlink regression");
    } finally {
      if (replacement && replacement !== dir) rmSync(replacement, { recursive: true });
      rmSync(dir, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);
