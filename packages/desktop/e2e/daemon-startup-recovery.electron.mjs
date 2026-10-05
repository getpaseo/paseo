import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { _electron as electron, expect } from "playwright/test";
import { savePersistedConfig } from "@getpaseo/server/configuration";
import {
  readDaemonInstance,
  startDaemonInstance,
  stopDaemonInstance,
} from "@getpaseo/server/daemon-control";
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
  let desktopHome = path.join(root, "recovery-daemon");
  let userData = path.join(root, "recovery-user-data");
  savePersistedConfig(desktopHome, {
    daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false } },
    features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
  });
  let metro;
  let desktop;
  let page;
  let protectedLaunch;
  const protectedHome = path.join(root, "password-daemon");
  let unrelatedServer;
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
    // Discovery can list other local services; all selections and lifecycle
    // actions below target only the test's ephemeral fixture ports and homes.
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
    const settingsPath = path.join(userData, "desktop-settings.json");
    await expect(page.getByTestId("welcome-screen")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("welcome-enable-local-daemon")).toBeVisible();
    await expect(page.getByText("Something went wrong", { exact: true })).toHaveCount(0);
    const initialSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(initialSettings.settings.daemon.manageBuiltInDaemon, false);
    await assert.rejects(readFile(path.join(desktopHome, "daemon.log")), { code: "ENOENT" });
    await page.screenshot({ path: path.join(root, "client-first-welcome.png") });
    await page.getByTestId("welcome-direct-connection").click();
    await page.getByTestId(`local-daemon-127.0.0.1:${port}`).click();
    await expect(page.getByTestId("direct-host-input")).toHaveValue("127.0.0.1");
    await expect(page.getByTestId("direct-port-input")).toHaveValue(String(port));
    await page.screenshot({ path: path.join(root, "client-first-discovery.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByTestId("welcome-enable-local-daemon").click();
    await expect
      .poll(
        async () => {
          const settings = JSON.parse(await readFile(settingsPath, "utf8"));
          const log = await readFile(path.join(desktopHome, "daemon.log"), "utf8").catch(() => "");
          return !settings.settings.daemon.manageBuiltInDaemon && log.includes("EADDRINUSE");
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect(page.getByTestId("welcome-screen")).toBeVisible();
    await expectExternalDaemonAlive();
    await closeDesktop();

    // Previously enabled profiles retain their choice and the error recovery path.
    initialSettings.settings.daemon.manageBuiltInDaemon = true;
    await writeFile(settingsPath, JSON.stringify(initialSettings));
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
    await page.getByTestId(`local-daemon-127.0.0.1:${port}`).click();
    await page.getByTestId("direct-host-submit").click();
    await expect(page.getByTestId("welcome-screen")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-settings")).toBeVisible();
    await page.screenshot({ path: path.join(root, "startup-existing-host-connected.png") });
    await closeDesktop();
    await expectExternalDaemonAlive();

    savePersistedConfig(protectedHome, {
      daemon: {
        listen: "127.0.0.1:0",
        relay: { enabled: false },
        cors: { allowedOrigins: metroPort ? [`http://127.0.0.1:${metroPort}`] : [] },
        auth: { password: "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW" },
      },
      features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
    });
    protectedLaunch = await startDaemonInstance({
      home: protectedHome,
      command: process.execPath,
      args: [path.join(repo, "packages/server/dist/scripts/supervisor-entrypoint.js")],
      env: { ...env, PASEO_HOME: protectedHome },
      mode: "deployment",
      timeoutMs: 30_000,
    });
    const protectedPort = new URL(`http://${protectedLaunch.instance.listen}`).port;
    assert.ok(!["6767", "6768"].includes(protectedPort));
    desktopHome = path.join(root, "password-client-home");
    userData = path.join(root, "password-user-data");
    savePersistedConfig(desktopHome, { daemon: { listen: `127.0.0.1:${protectedPort}` } });
    await openDesktop();
    await page.getByTestId("welcome-direct-connection").click({ timeout: 60_000 });
    const protectedCandidate = page.getByTestId(`local-daemon-127.0.0.1:${protectedPort}`);
    await expect(protectedCandidate).toContainText("Password required");
    await protectedCandidate.click();
    await page.screenshot({ path: path.join(root, "client-first-password-discovery.png") });
    await page.getByTestId("direct-password-input").fill("correct-password");
    await page.getByTestId("direct-host-submit").click();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 30_000 });
    await closeDesktop();
    assert.equal((await readDaemonInstance(protectedHome)).pid, protectedLaunch.instance.pid);
    await stopDaemonInstance(protectedHome, { instance: protectedLaunch.instance, force: true });
    protectedLaunch = null;

    // Explicit opt-in starts an owned daemon on an isolated port, persists across
    // launches and stops only that owned process when the client actually quits.
    desktopHome = path.join(root, "opt-in-daemon");
    userData = path.join(root, "opt-in-user-data");
    savePersistedConfig(desktopHome, {
      daemon: {
        listen: "127.0.0.1:0",
        relay: { enabled: false },
        cors: { allowedOrigins: metroPort ? [`http://127.0.0.1:${metroPort}`] : [] },
      },
      features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
    });
    await openDesktop();
    await expect(page.getByTestId("welcome-screen")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("welcome-enable-local-daemon").click();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 60_000 });
    const owned = await readDaemonInstance(desktopHome);
    assert.ok(owned?.pid);
    assert.equal(
      JSON.parse(await readFile(path.join(userData, "desktop-settings.json"), "utf8")).settings
        .daemon.manageBuiltInDaemon,
      true,
    );
    await page.screenshot({ path: path.join(root, "client-first-enabled.png") });
    await closeDesktop();
    await expect.poll(async () => await readDaemonInstance(desktopHome)).toBeNull();
    await expectExternalDaemonAlive();
    await openDesktop();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 60_000 });
    assert.notEqual((await readDaemonInstance(desktopHome))?.pid, owned.pid);
    await closeDesktop();
    await expect.poll(async () => await readDaemonInstance(desktopHome)).toBeNull();
    await expectExternalDaemonAlive();

    unrelatedServer = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise((resolve) => unrelatedServer.listen(0, "127.0.0.1", resolve));
    desktopHome = path.join(root, "empty-discovery-home");
    userData = path.join(root, "empty-discovery-user-data");
    savePersistedConfig(desktopHome, {
      daemon: { listen: `127.0.0.1:${unrelatedServer.address().port}` },
    });
    await openDesktop();
    await page.getByTestId("welcome-direct-connection").click({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled({
      timeout: 10_000,
    });
    await expect(
      page.getByTestId(`local-daemon-127.0.0.1:${unrelatedServer.address().port}`),
    ).toHaveCount(0);
    await expect(page.getByTestId("direct-host-input")).toBeEditable();
    await page.screenshot({ path: path.join(root, "client-first-empty-discovery.png") });
    await closeDesktop();
    console.log(
      "PASS: fresh client starts without daemon; discovery selects a real existing host and detects password protection; unrelated HTTP services are ignored; explicit opt-in survives relaunch and owned daemon stops on quit; failed opt-in restores client-only mode; old profiles recover from real port conflicts; failed settings write stays recoverable; external daemon survives quit.",
    );
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(root, "startup-recovery-failure.png") });
      console.log(await page.locator("body").innerText());
    }
    throw error;
  } finally {
    await closeDesktop();
    if (protectedLaunch)
      await stopDaemonInstance(protectedHome, { instance: protectedLaunch.instance, force: true });
    if (unrelatedServer) {
      unrelatedServer.closeAllConnections();
      await new Promise((resolve) => unrelatedServer.close(resolve));
    }
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
