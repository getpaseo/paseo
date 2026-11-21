import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import electronPath from "electron";
import { build } from "esbuild";

export async function runAdaptiveThemeRegression(artifactDir) {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("../../app", import.meta.url)),
      contents: `
        import { createElement } from "react";
        import { createRoot } from "react-dom/client";
        import { StyleSheet, UnistylesRuntime, withUnistyles } from "react-native-unistyles";
        StyleSheet.configure({
          themes: {
            dark: { foreground: "#fafafa", background: "#181b1a" },
            light: { foreground: "#1a1a1e", background: "#ffffff" },
          },
          settings: { adaptiveThemes: true },
        });
        const Message = withUnistyles(({ color }) =>
          createElement("p", { style: { color } }, "Theme-reactive message"));
        createRoot(document.getElementById("root")).render(createElement(Message, {
          style: { margin: 0 },
          uniProps: theme => ({ color: theme.foreground }),
        }));
        window.readThemeForTest = () => UnistylesRuntime.themeName;
      `,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    alias: { "react-native": "react-native-web" },
    define: { __DEV__: "false" },
    resolveExtensions: [".web.js", ".js", ".json"],
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-adaptive-theme-"));
  try {
    await fs.writeFile(path.join(directory, "renderer.js"), outputFiles[0].text);
    await fs.writeFile(path.join(directory, "main.cjs"), `(${electronRegression.toString()})()`);
    // A separate process avoids Playwright's focus emulation, which keeps hidden pages visible.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      path.join(directory, "main.cjs"),
      artifactDir,
    ];
    const command = process.platform === "linux" ? "xvfb-run" : electronPath;
    const commandArgs =
      process.platform === "linux"
        ? ["-a", "--server-args=-screen 0 1280x800x24", electronPath, ...args]
        : args;
    await promisify(execFile)(command, commandArgs, {
      env,
      timeout: 30_000,
    });
    return JSON.parse(await fs.readFile(path.join(artifactDir, "adaptive-theme.json"), "utf8"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function electronRegression() {
  const { app, BrowserWindow, nativeTheme } = require("electron");
  const assert = require("node:assert/strict");
  const files = require("node:fs");
  const paths = require("node:path");
  const { setTimeout: delay } = require("node:timers/promises");
  app.setPath("userData", paths.join(__dirname, "profile"));
  app.on("window-all-closed", () => {});
  // Electron keeps Linux's --no-sandbox in argv; the artifact directory is always last.
  const artifactDir = process.argv.at(-1);
  let window;
  const observations = [];
  const colors = {
    dark: { foreground: "rgb(250, 250, 250)", background: "rgb(24, 27, 26)" },
    light: { foreground: "rgb(26, 26, 30)", background: "rgb(255, 255, 255)" },
  };
  async function read(expression) {
    return window.webContents.executeJavaScript(expression);
  }
  async function expectValue(expression, expected) {
    let actual;
    for (let attempt = 0; attempt < 50; attempt++) {
      actual = await read(expression);
      if (actual === expected) return;
      await delay(50);
    }
    assert.equal(actual, expected, expression);
  }
  try {
    await app.whenReady();
    if (process.platform === "darwin") {
      app.setActivationPolicy("accessory");
      app.dock.hide();
    }
    for (const [from, to] of [
      ["dark", "light"],
      ["light", "dark"],
    ]) {
      nativeTheme.themeSource = from;
      window = new BrowserWindow({ width: 600, height: 200, show: false, skipTaskbar: true });
      await window.loadURL(
        "data:text/html," +
          encodeURIComponent(`<!doctype html>
        <style>body { background: var(--background); } p { font: 20px system-ui; }</style>
        <div id="root"></div>`),
      );
      await read(files.readFileSync(paths.join(__dirname, "renderer.js"), "utf8"));
      window.showInactive();
      const foreground =
        "document.querySelector('p') && getComputedStyle(document.querySelector('p')).color";
      const background = "getComputedStyle(document.body).backgroundColor";
      await expectValue(foreground, colors[from].foreground);
      await expectValue(background, colors[from].background);
      window.hide();
      await expectValue("document.visibilityState", "hidden");
      nativeTheme.themeSource = to;
      await expectValue(`matchMedia('(prefers-color-scheme: ${to})').matches`, true);
      // Reading the public runtime while hidden must not consume the pending theme notification.
      assert.equal(await read("window.readThemeForTest()"), to);
      window.showInactive();
      await expectValue("document.visibilityState", "visible");
      await expectValue(background, colors[to].background);
      try {
        await expectValue(foreground, colors[to].foreground);
      } finally {
        files.writeFileSync(
          paths.join(artifactDir, `theme-${from}-to-${to}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
      observations.push({
        from,
        to,
        foreground: await read(foreground),
        background: await read(background),
      });
      window.destroy();
      window = undefined;
    }
    files.writeFileSync(
      paths.join(artifactDir, "adaptive-theme.json"),
      JSON.stringify(observations, null, 2),
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    window?.destroy();
    app.exit(1);
  }
}
