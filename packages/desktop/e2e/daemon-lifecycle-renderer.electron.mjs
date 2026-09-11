import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { _electron as electron, expect } from "playwright/test";
import { readDaemonInstance } from "@getpaseo/server";

// Run under the test's private Xvfb display; native dialog input never targets
// a user's desktop. All daemon operations still cross the real preload/IPC.
export async function verifyAttachedDaemonControls({ repo, root, env, home, port, instance }) {
  if (!process.env.DISPLAY)
    throw new Error("Renderer lifecycle QA requires a private Xvfb display");
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const metroPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const metro = spawn(
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
      detached: true,
      stdio: "ignore",
      env: {
        ...env,
        EXPO_NO_DOTENV: "1",
        CI: "1",
        PASEO_WEB_PLATFORM: "electron",
        EXPO_PUBLIC_LOCAL_DAEMON: `127.0.0.1:${port}`,
      },
    },
  );
  let desktop;
  let page;
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${metroPort}/status`)).ok;
          } catch {
            return false;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    desktop = await electron.launch({
      args: [path.join(repo, "packages/desktop/dist/main.js"), "--no-sandbox"],
      env: {
        ...env,
        EXPO_DEV_URL: `http://127.0.0.1:${metroPort}`,
        PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
        PASEO_ELECTRON_USER_DATA_DIR: path.join(root, "renderer-user-data"),
      },
    });
    page = await desktop.firstWindow();
    page.on("pageerror", (error) => console.log("Renderer error:", error.message));
    await page.route(/:(6767|6768)\b/, (route) => route.abort());
    await page.getByRole("button", { name: "Settings", exact: true }).click({ timeout: 90_000 });
    await page.getByRole("button", { name: "Enable built-in daemon", exact: true }).click();
    await expect(page.getByText("Attached to an existing daemon", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Removes localhost from this device and stops the built-in daemon", {
        exact: true,
      }),
    ).toBeHidden();
    await page
      .getByText("Attached to an existing daemon", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, "attached-daemon.png") });

    async function respondToNativeDialog(title, artifact, key) {
      let windowId;
      await expect
        .poll(
          () => {
            try {
              windowId = execFileSync("xdotool", ["search", "--onlyvisible", "--name", title], {
                encoding: "utf8",
              })
                .trim()
                .split("\n")
                .at(-1);
              return Boolean(windowId);
            } catch {
              return false;
            }
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      const screenshot = await desktop.evaluate(async ({ desktopCapturer }) => {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 1280, height: 800 },
        });
        return sources[0].thumbnail.toPNG().toString("base64");
      });
      await writeFile(path.join(root, artifact), Buffer.from(screenshot, "base64"));
      // Escape destroys the dialog on key-down. Send through the private display
      // focus so key-up does not target an already-destroyed X11 window.
      execFileSync("xdotool", ["windowfocus", "--sync", windowId, "key", key]);
    }

    const management = page.getByRole("switch", { name: "Manage built-in daemon" });
    await management.click();
    await respondToNativeDialog(
      "Pause built-in daemon",
      "pause-attached-confirmation.png",
      "Return",
    );
    await expect(management).not.toBeChecked();
    expect((await readDaemonInstance(home)).pid).toBe(instance.pid);

    await page.getByRole("button", { name: "Stop daemon", exact: true }).click();
    await respondToNativeDialog("Stop local daemon", "stop-attached-cancelled.png", "Escape");
    await expect(page.getByRole("button", { name: "Stop daemon", exact: true })).toBeEnabled();
    expect(await readDaemonInstance(home)).toMatchObject({
      pid: instance.pid,
      startedAt: instance.startedAt,
    });

    await page.getByRole("button", { name: "Stop daemon", exact: true }).click();
    await respondToNativeDialog("Stop local daemon", "stop-attached-confirmation.png", "Return");
    await expect.poll(() => readDaemonInstance(home), { timeout: 20_000 }).toBeNull();
    await expect(page.getByRole("button", { name: "Stop daemon", exact: true })).toBeHidden();
    await page.screenshot({ path: path.join(root, "attached-daemon-stopped.png") });
    console.log(
      "PASS: real Desktop renderer pauses management without stopping an attached daemon, then confirms and stops that instance.",
    );
  } catch (error) {
    if (page) {
      console.log(
        "Renderer state:",
        await page
          .locator("body")
          .innerText()
          .catch(() => "closed"),
      );
      await page.screenshot({ path: path.join(root, "renderer-failure.png") }).catch(() => {});
    }
    throw error;
  } finally {
    if (desktop) {
      const exited = once(desktop.process(), "exit");
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await exited;
    }
    if (metro.exitCode === null) {
      const exited = once(metro, "exit");
      process.kill(-metro.pid, "SIGTERM");
      await exited;
    }
  }
}
