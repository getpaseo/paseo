import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __resetMaterializedImageAttachmentDirForTests,
  materializeProviderImage,
} from "./provider-image-output.js";

describe.skipIf(process.platform === "win32")("materializeProviderImage", () => {
  const originalPaseoHome = process.env.PASEO_HOME;
  let testHome: string | null = null;

  beforeEach(() => {
    testHome = mkdtempSync(path.join(os.tmpdir(), "paseo-provider-images-posix-"));
    process.env.PASEO_HOME = testHome;
    __resetMaterializedImageAttachmentDirForTests();
  });

  afterEach(() => {
    if (originalPaseoHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = originalPaseoHome;
    }
    if (testHome) {
      rmSync(testHome, { recursive: true, force: true });
      testHome = null;
    }
    __resetMaterializedImageAttachmentDirForTests();
  });

  test("writes image attachments under a private directory in the paseo home", () => {
    const materialized = materializeProviderImage({
      data: "YWJjMTIz",
      mimeType: "image/png",
    });
    const attachmentDir = path.dirname(materialized.path);

    // Exactly "paseo-attachments" — no mkdtemp suffix. The old per-process temp
    // directory is what let the OS reap these images out from under the app.
    expect(path.basename(attachmentDir)).toBe("paseo-attachments");
    expect(attachmentDir).toBe(path.join(testHome as string, "paseo-attachments"));
    expect(existsSync(materialized.path)).toBe(true);
    expect(statSync(attachmentDir).mode & 0o777).toBe(0o700);
    expect(statSync(materialized.path).mode & 0o777).toBe(0o600);
  });
});
