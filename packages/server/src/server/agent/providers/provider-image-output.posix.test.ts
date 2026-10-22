import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { materializeProviderImage } from "./provider-image-output.js";

describe.skipIf(process.platform === "win32")("materializeProviderImage", () => {
  test("writes image attachments under a private temp directory", () => {
    const materialized = materializeProviderImage({
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
