import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { materializeProviderImage } from "./provider-image-output.js";

describe("materializeProviderImage", () => {
  test("writes image attachments under a private user temp directory", () => {
    const materialized = materializeProviderImage({
      data: "YWJjMTIz",
      mimeType: "image/png",
    });

    try {
      const attachmentDir = path.dirname(materialized.path);
      expect(path.basename(path.dirname(attachmentDir))).toBe("paseo-attachments");
      expect(path.basename(attachmentDir)).toMatch(/^user-/);
      expect(existsSync(materialized.path)).toBe(true);
      expect(statSync(attachmentDir).mode & 0o777).toBe(0o700);
      expect(statSync(materialized.path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(materialized.path, { force: true });
    }
  });
});
