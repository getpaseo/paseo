import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig, resolveBundledWebUiDistDir } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-web-ui-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

function expectBundledWebUiDistDir(distDir: string | null): void {
  expect(distDir).not.toBeNull();
  expect(path.isAbsolute(distDir ?? "")).toBe(true);
  expect(distDir?.endsWith(path.join("packages", "server", "dist", "server", "web-ui"))).toBe(true);
}

describe("daemon web UI config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("web UI is disabled by default", async () => {
    const home = await createPaseoHome({ version: 1 });

    const config = loadConfig(home, { env: {} });

    expect(config.webUi.enabled).toBe(false);
    expectBundledWebUiDistDir(config.webUi.distDir);
  });

  test("enables web UI from persisted config", async () => {
    const home = await createPaseoHome({
      version: 1,
      features: { webUi: { enabled: true } },
    });

    const config = loadConfig(home, { env: {} });

    expect(config.webUi.enabled).toBe(true);
    expectBundledWebUiDistDir(config.webUi.distDir);
  });

  test("resolves bundled web UI dist dir from TypeScript source modules", () => {
    const packageRoot = path.join(os.tmpdir(), "paseo-config-web-ui-source-package");
    const moduleUrl = pathToFileURL(path.join(packageRoot, "src", "server", "config.ts"));

    expect(resolveBundledWebUiDistDir(moduleUrl)).toBe(
      path.join(packageRoot, "dist", "server", "web-ui"),
    );
  });

  test("resolves bundled web UI dist dir from compiled server modules", () => {
    const packageRoot = path.join(os.tmpdir(), "paseo-config-web-ui-dist-package");
    const moduleUrl = pathToFileURL(path.join(packageRoot, "dist", "server", "config.js"));

    expect(resolveBundledWebUiDistDir(moduleUrl)).toBe(
      path.join(packageRoot, "dist", "server", "web-ui"),
    );
  });

  test("PASEO_WEB_UI_ENABLED overrides persisted setting", async () => {
    const home = await createPaseoHome({
      version: 1,
      features: { webUi: { enabled: true } },
    });

    const config = loadConfig(home, { env: { PASEO_WEB_UI_ENABLED: "false" } });

    expect(config.webUi.enabled).toBe(false);
  });

  test("PASEO_WEB_UI_ENABLED=true enables web UI", async () => {
    const home = await createPaseoHome({ version: 1 });

    const config = loadConfig(home, { env: { PASEO_WEB_UI_ENABLED: "true" } });

    expect(config.webUi.enabled).toBe(true);
  });

  test("CLI web UI enable override wins over env and persisted config", async () => {
    const home = await createPaseoHome({
      version: 1,
      features: { webUi: { enabled: false } },
    });

    const config = loadConfig(home, {
      env: { PASEO_WEB_UI_ENABLED: "false" },
      cli: { webUiEnabled: true },
    });

    expect(config.webUi.enabled).toBe(true);
  });

  test("CLI web UI disable override wins over env and persisted config", async () => {
    const home = await createPaseoHome({
      version: 1,
      features: { webUi: { enabled: true } },
    });

    const config = loadConfig(home, {
      env: { PASEO_WEB_UI_ENABLED: "true" },
      cli: { webUiEnabled: false },
    });

    expect(config.webUi.enabled).toBe(false);
  });

  test("resolves PASEO_WEB_UI_DIST_DIR as absolute path", async () => {
    const home = await createPaseoHome({ version: 1 });
    const distDir = path.join(os.tmpdir(), "paseo-web-ui-dist");

    const config = loadConfig(home, { env: { PASEO_WEB_UI_DIST_DIR: distDir } });

    expect(config.webUi.distDir).toBe(path.resolve(distDir));
  });

  test("resolves relative persisted distDir against PASEO_HOME", async () => {
    const home = await createPaseoHome({
      version: 1,
      features: { webUi: { distDir: "web-ui-dist" } },
    });

    const config = loadConfig(home, { env: {} });

    expect(config.webUi.distDir).toBe(path.join(home, "web-ui-dist"));
  });

  test("PASEO_WEB_UI_DIST_DIR overrides persisted distDir", async () => {
    const home = await createPaseoHome({
      version: 1,
      features: { webUi: { distDir: "/persisted/dist" } },
    });
    const envDir = path.join(os.tmpdir(), "env-dist");

    const config = loadConfig(home, { env: { PASEO_WEB_UI_DIST_DIR: envDir } });

    expect(config.webUi.distDir).toBe(path.resolve(envDir));
  });
});
