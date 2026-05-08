import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolvePaseoHome } from "./paseo-home.js";
import { PRIVATE_DIRECTORY_MODE } from "./private-files.js";

const MODE_MASK = 0o777;

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe.skipIf(process.platform === "win32")("resolvePaseoHome permissions", () => {
  test("creates PASEO_HOME with private permissions", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "paseo-home-parent-"));
    const paseoHome = path.join(parent, "home");
    try {
      expect(resolvePaseoHome({ PASEO_HOME: paseoHome })).toBe(paseoHome);
      expect(modeOf(paseoHome)).toBe(PRIVATE_DIRECTORY_MODE);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
