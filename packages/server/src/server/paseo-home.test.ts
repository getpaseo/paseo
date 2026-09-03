import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolvePaseoHome } from "./paseo-home.js";
import { XDG_LAYOUT_MARKER } from "./paseo-paths.js";
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

  test.skipIf(process.platform !== "linux")(
    "records XDG layout selection for later processes",
    () => {
      const homeDirectory = mkdtempSync(path.join(tmpdir(), "paseo-xdg-home-"));
      try {
        const paseoHome = resolvePaseoHome({}, "linux", homeDirectory);

        expect(paseoHome).toBe(path.join(homeDirectory, ".local", "share", "paseo"));
        expect(existsSync(path.join(paseoHome, XDG_LAYOUT_MARKER))).toBe(true);
        expect(modeOf(path.join(paseoHome, XDG_LAYOUT_MARKER))).toBe(0o600);
      } finally {
        rmSync(homeDirectory, { recursive: true, force: true });
      }
    },
  );
});
