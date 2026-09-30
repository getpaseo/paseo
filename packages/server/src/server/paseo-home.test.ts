import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolvePaseoHome } from "./paseo-home.js";

describe("resolvePaseoHome", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "paseo-home-parent-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  test("resolves PASEO_HOME without creating it", () => {
    const paseoHome = path.join(homeDir, "home");
    expect(resolvePaseoHome({ PASEO_HOME: paseoHome }, homeDir)).toBe(paseoHome);
    expect(existsSync(paseoHome)).toBe(false);
  });

  test("PANDAOS_HOME wins over PASEO_HOME", () => {
    expect(resolvePaseoHome({ PANDAOS_HOME: "/a", PASEO_HOME: "/b" }, homeDir)).toBe("/a");
  });

  test("expands ~ in an explicit home", () => {
    expect(resolvePaseoHome({ PANDAOS_HOME: "~/custom" }, homeDir)).toBe(
      path.join(homeDir, "custom"),
    );
  });

  test("a fresh install defaults to ~/.pandaos", () => {
    expect(resolvePaseoHome({}, homeDir)).toBe(path.join(homeDir, ".pandaos"));
  });

  test("an unmigrated install keeps using ~/.paseo", () => {
    mkdirSync(path.join(homeDir, ".paseo"));
    expect(resolvePaseoHome({}, homeDir)).toBe(path.join(homeDir, ".paseo"));
  });

  test("~/.pandaos wins once it exists", () => {
    mkdirSync(path.join(homeDir, ".paseo"));
    mkdirSync(path.join(homeDir, ".pandaos"));
    expect(resolvePaseoHome({}, homeDir)).toBe(path.join(homeDir, ".pandaos"));
  });
});
