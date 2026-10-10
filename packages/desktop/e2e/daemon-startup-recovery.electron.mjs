import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
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

// An existing daemon in another home must be reused without launching a second
// worker. A non-Paseo listener still exercises real EADDRINUSE recovery below.
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
    // A healthy daemon in another home is reused before a bundled launch.
    await openDesktop();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 60_000 });
    const externalProfile = await page.evaluate(
      () => JSON.parse(localStorage.getItem("@paseo:daemon-registry"))[0],
    );
    await expect(page.getByText("Something went wrong", { exact: true })).toHaveCount(0);
    assert.equal(
      JSON.parse(await readFile(path.join(userData, "desktop-settings.json"), "utf8")).settings
        .daemon.manageBuiltInDaemon,
      true,
    );
    await assert.rejects(readFile(path.join(desktopHome, "daemon.log")), { code: "ENOENT" });
    assert.equal(await readDaemonInstance(desktopHome), null);
    const attachedStatus = await page.evaluate(() =>
      window.paseoDesktop.invoke("desktop_daemon_status"),
    );
    assert.equal(attachedStatus.ownedByDesktop, false);
    await page.screenshot({ path: path.join(root, "reuse-existing-automatic.png") });
    await closeDesktop();
    await expectExternalDaemonAlive();
    await openDesktop();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 60_000 });
    await assert.rejects(readFile(path.join(desktopHome, "daemon.log")), { code: "ENOENT" });
    await closeDesktop();
    await expectExternalDaemonAlive();

    // A port reused by a different daemon must not migrate the old host's
    // identity, relay connection, appearance or password into the new host.
    await openDesktop();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 60_000 });
    const previousProfile = {
      ...externalProfile,
      serverId: "srv_previous_home",
      label: "Previous daemon home",
      password: "previous-password",
      connections: [
        { ...externalProfile.connections[0], useTls: false },
        {
          id: "relay:127.0.0.1:1",
          type: "relay",
          relayEndpoint: "127.0.0.1:1",
          useTls: false,
          daemonPublicKeyB64: Buffer.alloc(32, 1).toString("base64"),
        },
      ],
    };
    await page.evaluate((profile) => {
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([profile]));
    }, previousProfile);
    await closeDesktop();
    await openDesktop();
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            JSON.parse(localStorage.getItem("@paseo:daemon-registry")).map((host) => host.serverId),
          ),
        { timeout: 30_000 },
      )
      .toEqual([previousProfile.serverId, externalProfile.serverId]);
    const separatedProfiles = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("@paseo:daemon-registry")),
    );
    assert.deepEqual(separatedProfiles[0], previousProfile);
    assert.equal(separatedProfiles[1].connections.length, 1);
    assert.equal(separatedProfiles[1].connections[0].type, "directTcp");
    assert.equal(separatedProfiles[1].password, undefined);
    await assert.rejects(readFile(path.join(desktopHome, "daemon.log")), { code: "ENOENT" });
    await closeDesktop();
    await expectExternalDaemonAlive();

    // An unrelated HTTP server must not be mistaken for Paseo. A real bind
    // failure must retain the previously added recoverable settings/error UI.
    unrelatedServer = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise((resolve) => unrelatedServer.listen(0, "127.0.0.1", resolve));
    const blockedPort = unrelatedServer.address().port;
    assert.ok(![6767, 6768].includes(blockedPort));
    desktopHome = path.join(root, "blocked-daemon-home");
    userData = path.join(root, "blocked-user-data");
    savePersistedConfig(desktopHome, {
      daemon: { listen: `127.0.0.1:${blockedPort}`, relay: { enabled: false } },
      features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
    });
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
    const settingsPath = path.join(userData, "desktop-settings.json");
    await rename(settingsPath, `${settingsPath}.backup`);
    await mkdir(settingsPath);
    await continueButton.click();
    await expect(page.getByTestId("startup-recovery-error")).toContainText("Unable to save");
    await expect(continueButton).toBeEnabled();
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
    await openDesktop();
    await expect(page.getByTestId("welcome-screen")).toBeVisible({ timeout: 60_000 });
    assert.equal(await readFile(path.join(desktopHome, "daemon.log"), "utf8"), failedDaemonLog);
    await page.getByTestId("welcome-direct-connection").click();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled({
      timeout: 10_000,
    });
    await expect(page.getByTestId(`local-daemon-127.0.0.1:${blockedPort}`)).toHaveCount(0);
    await page.getByTestId("direct-host-input").fill("127.0.0.1");
    await page.getByTestId("direct-port-input").fill(String(port));
    await page.getByTestId("direct-host-submit").click();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible();
    await closeDesktop();
    await expectExternalDaemonAlive();

    // A protected daemon opens a prefilled connection form instead of causing
    // a port conflict. A saved password keeps working on the next app launch.
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
    await expect(page.getByTestId("add-host-modal")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("direct-host-input")).toHaveValue("127.0.0.1");
    await expect(page.getByTestId("direct-port-input")).toHaveValue(protectedPort);
    await expect(page.getByTestId(`local-daemon-127.0.0.1:${protectedPort}`)).toContainText(
      "Password required",
    );
    await assert.rejects(readFile(path.join(desktopHome, "daemon.log")), { code: "ENOENT" });
    await page.screenshot({ path: path.join(root, "reuse-existing-password.png") });
    await page.evaluate((profile) => {
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([profile]));
    }, externalProfile);
    await closeDesktop();
    await openDesktop();
    await expect(page.getByTestId("add-host-modal")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("direct-port-input")).toHaveValue(protectedPort);
    await page.screenshot({ path: path.join(root, "password-with-saved-online-host.png") });
    await page
      .getByTestId("add-host-modal")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(page.getByTestId("add-host-modal")).toHaveCount(0);
    const offlineConnection = {
      id: `direct:localhost:${blockedPort}`,
      type: "directTcp",
      endpoint: `localhost:${blockedPort}`,
      useTls: false,
    };
    const offlineProfile = {
      ...externalProfile,
      serverId: "srv_saved_offline",
      label: "Saved offline host",
      connections: [offlineConnection],
      preferredConnectionId: offlineConnection.id,
    };
    await page.evaluate((profile) => {
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([profile]));
    }, offlineProfile);
    await closeDesktop();
    await openDesktop();
    await expect(page.getByTestId("add-host-modal")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("direct-port-input")).toHaveValue(protectedPort);
    await page.screenshot({ path: path.join(root, "password-with-saved-offline-host.png") });
    await page.getByTestId("direct-password-input").fill("correct-password");
    await page.getByTestId("direct-host-submit").click();
    await expect(page.getByTestId("add-host-modal")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 30_000 });
    await closeDesktop();
    assert.equal((await readDaemonInstance(protectedHome)).pid, protectedLaunch.instance.pid);
    await openDesktop();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const store = globalThis.__paseoHostRuntimeStore;
          return store
            .getHosts()
            .filter((host) => store.getSnapshot(host.serverId)?.connectionStatus === "online")
            .length;
        }),
      )
      .toBe(1);
    await expect(page.getByTestId("add-host-modal")).toHaveCount(0);
    await assert.rejects(readFile(path.join(desktopHome, "daemon.log")), { code: "ENOENT" });
    await closeDesktop();
    await stopDaemonInstance(protectedHome, { instance: protectedLaunch.instance, force: true });
    protectedLaunch = null;

    // No daemon at the configured address: the original automatic startup and
    // owned-process shutdown behavior remains intact, even with other hosts online.
    desktopHome = path.join(root, "automatic-daemon");
    userData = path.join(root, "automatic-user-data");
    savePersistedConfig(desktopHome, {
      daemon: {
        listen: "127.0.0.1:0",
        relay: { enabled: false },
        cors: { allowedOrigins: metroPort ? [`http://127.0.0.1:${metroPort}`] : [] },
      },
      features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
    });
    await openDesktop();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 60_000 });
    const owned = await readDaemonInstance(desktopHome);
    assert.ok(owned?.pid);
    const ownedStatus = await page.evaluate(() =>
      window.paseoDesktop.invoke("desktop_daemon_status"),
    );
    assert.equal(ownedStatus.ownedByDesktop, true);
    await page.screenshot({ path: path.join(root, "reuse-existing-auto-start-fallback.png") });
    await closeDesktop();
    await expect.poll(async () => await readDaemonInstance(desktopHome)).toBeNull();
    await openDesktop();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 60_000 });
    assert.notEqual((await readDaemonInstance(desktopHome))?.pid, owned.pid);
    await closeDesktop();
    await expect.poll(async () => await readDaemonInstance(desktopHome)).toBeNull();
    await expectExternalDaemonAlive();
    console.log(
      "PASS: automatic reuse across homes without spawning or owning a daemon; reused ports preserve old host identities and credentials; password form works with saved online/offline hosts and can be dismissed; saved passwords reconnect without prompting; original auto-start and quit lifecycle preserved; explicit disable persists; unrelated HTTP services are ignored; startup errors and settings-write failures remain recoverable.",
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
