import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { _electron as electron, expect } from "playwright/test";
import { savePersistedConfig } from "@getpaseo/server/configuration";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";
import { warmMetro } from "../../app/e2e/support/metro-warmup.mjs";

// Use a different home at the existing daemon's address: Desktop cannot discover
// its PID file, and its own worker must fail with a real EADDRINUSE.
export async function verifyStartupFailureRecovery({
  repo,
  root,
  env,
  home,
  port,
  metroPort,
  instance,
  executablePath,
  launchDesktop = (options) => electron.launch(options),
}) {
  const desktopHome = path.join(root, "recovery-daemon");
  const userData = path.join(root, "recovery-user-data");
  savePersistedConfig(desktopHome, {
    daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false } },
    features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
  });
  let metro;
  let desktop;
  let page;
  async function openDesktop() {
    desktop = await launchDesktop({
      ...(executablePath ? { executablePath } : {}),
      args: [
        ...(executablePath ? [] : [path.join(repo, "packages/desktop/dist/main.js")]),
        "--no-sandbox",
      ],
      env: {
        ...env,
        ...(metroPort ? { EXPO_DEV_URL: `http://127.0.0.1:${metroPort}` } : {}),
        PASEO_HOME: desktopHome,
        PASEO_ELECTRON_USER_DATA_DIR: userData,
        PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
      },
    });
    page = await desktop.firstWindow();
  }
  async function closeDesktop() {
    if (!desktop) return;
    await desktop.close();
    desktop = null;
  }
  async function expectExternalDaemonAlive() {
    assert.equal((await readDaemonInstance(home)).pid, instance.pid);
    process.kill(instance.pid, 0);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  }
  try {
    if (!executablePath) {
      const log = openSync(path.join(root, "recovery-metro.log"), "w");
      metro = spawn(
        process.execPath,
        [
          path.join(repo, "node_modules/expo/bin/cli"),
          "start",
          "--web",
          "--port",
          String(metroPort),
          "--offline",
        ],
        {
          cwd: path.join(repo, "packages/app"),
          detached: process.platform !== "win32",
          stdio: ["ignore", log, log],
          env: { ...env, EXPO_NO_DOTENV: "1", CI: "1", PASEO_WEB_PLATFORM: "electron" },
        },
      );
      closeSync(log);
      await expect
        .poll(
          async () => {
            try {
              return await (await fetch(`http://127.0.0.1:${metroPort}/status`)).text();
            } catch {
              return "";
            }
          },
          { timeout: 60_000 },
        )
        .toBe("packager-status:running");
      await warmMetro(metroPort);
    }
    await openDesktop();
    await expect(page.getByText("Something went wrong", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(/EADDRINUSE/).first()).toBeVisible();
    await page.screenshot({ path: path.join(root, "startup-port-conflict.png") });
    const continueButton = page.getByRole("button", {
      name: "Continue without local server",
      exact: true,
    });
    await expect(continueButton).toBeVisible();
    await expectExternalDaemonAlive();

    // Make the real settings store's atomic rename fail, without mocking IPC.
    const settingsPath = path.join(userData, "desktop-settings.json");
    await rename(settingsPath, `${settingsPath}.backup`);
    await mkdir(settingsPath);
    await continueButton.click();
    await expect(page.getByTestId("startup-recovery-error")).toContainText("Unable to save");
    await expect(continueButton).toBeEnabled();
    await expect(page.getByText("Something went wrong", { exact: true })).toBeVisible();
    await expect(page.getByTestId("welcome-screen")).toHaveCount(0);
    await page.screenshot({ path: path.join(root, "startup-settings-write-failed.png") });
    await rm(settingsPath, { recursive: true });
    await rename(`${settingsPath}.backup`, settingsPath);

    await continueButton.click();
    await expect(page.getByTestId("welcome-screen")).toBeVisible();
    assert.equal(
      JSON.parse(await readFile(settingsPath, "utf8")).settings.daemon.manageBuiltInDaemon,
      false,
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Enable built-in daemon", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: path.join(root, "startup-recovered-settings.png") });

    const failedDaemonLog = await readFile(path.join(desktopHome, "daemon.log"), "utf8");
    await closeDesktop();
    await expectExternalDaemonAlive();
    await openDesktop();
    await expect(page.getByTestId("welcome-screen")).toBeVisible({ timeout: 60_000 });
    assert.equal(await readFile(path.join(desktopHome, "daemon.log"), "utf8"), failedDaemonLog);
    await page.getByTestId("welcome-direct-connection").click();
    await page.getByTestId("direct-host-input").fill("127.0.0.1");
    await page.getByTestId("direct-port-input").fill(String(port));
    await page.getByTestId("direct-host-submit").click();
    await expect(page.getByTestId("welcome-screen")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-settings")).toBeVisible();
    await page.screenshot({ path: path.join(root, "startup-existing-host-connected.png") });
    await closeDesktop();
    await expectExternalDaemonAlive();
    console.log(
      "PASS: real port conflict; failed settings write stays recoverable; client-only choice persists; settings and direct connection work; existing daemon survives quit.",
    );
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(root, "startup-recovery-failure.png") });
      console.log(await page.locator("body").innerText());
    }
    throw error;
  } finally {
    await closeDesktop();
    if (metro && metro.exitCode === null) {
      const exited = once(metro, "exit");
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(metro.pid), "/T", "/F"]);
      } else {
        process.kill(-metro.pid, "SIGTERM");
      }
      await exited;
    }
  }
}
