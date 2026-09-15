import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect } from "playwright/test";
import { runElectronScenario } from "./support/electron-session.mjs";
import { startTerminalKeyboardRecording } from "./support/terminal-keyboard-recording.mjs";

const recordVideo = process.argv.includes("--record");
let recording;

const artifactDir = path.resolve(
  process.env.PASEO_TERMINAL_ARROW_ARTIFACT_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), "paseo-terminal-arrows-")),
);
fs.mkdirSync(artifactDir, { recursive: true });
assert.equal(process.platform, "darwin", "This check requires real macOS Electron");

const report = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  runtimeBlob: execFileSync(
    "git",
    [
      "hash-object",
      fileURLToPath(
        new URL("../../app/src/terminal/runtime/terminal-emulator-runtime.ts", import.meta.url),
      ),
    ],
    { encoding: "utf8" },
  ).trim(),
  macOS: execFileSync("sw_vers", [], { encoding: "utf8" }).trim(),
  arch: process.arch,
  hostname: os.hostname(),
  kernel: os.release(),
  recording: recordVideo,
  input: "Playwright keyboard events sent through CDP to the real Electron renderer",
  steps: [],
};

async function checkpoint(page, name, details) {
  if (recording) await delay(3_000);
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
  report.steps.push({ name, recordedAt: new Date().toISOString(), ...details });
  console.log(`PASS ${name}: ${JSON.stringify(details)}`);
}

async function pressKey(page, key) {
  const labels = { Meta: "Cmd", Alt: "Option", ArrowLeft: "←", ArrowRight: "→" };
  await recording?.showKey(
    key
      .split("+")
      .map((part) => labels[part] ?? part)
      .join(" + "),
  );
  await page.keyboard.press(key);
}

async function typeRecordedText(page, text) {
  await recording?.showKey(`Type: ${text}`);
  await page.keyboard.type(text, { delay: recordVideo ? 100 : 0 });
}

async function setRecordingFontSize(page) {
  await page.getByTestId("sidebar-settings").click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Code font size", exact: true });
  await input.fill("22");
  await input.press("Tab");
  assert.equal(await input.inputValue(), "22");
  await page.getByTestId("settings-back-to-workspace").click();
}

async function waitForValue(read, expected, message) {
  const deadline = Date.now() + 10_000;
  let actual;
  do {
    actual = await read();
    if (actual === expected) return;
    await delay(50);
  } while (Date.now() < deadline);
  assert.equal(actual, expected, message);
}

async function runAction(page, title) {
  await recording?.showKey(`Command Center: ${title}`);
  await page.getByTestId("sidebar-search").click();
  const panel = page.getByTestId("command-center-panel");
  await panel.getByTestId("command-center-input").fill(title);
  await panel.getByRole("button", { name: new RegExp(`^${title}(?:\\s|$)`) }).click();
  await panel.waitFor({ state: "hidden" });
}

function readShellFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function terminalInput(surface) {
  return surface.getByRole("textbox", { name: "Terminal input", exact: true });
}

function terminalTabs(pane) {
  return pane.getByRole("button", { name: /^Terminal \d+$/ });
}

function terminalTab(pane, name) {
  return pane.getByRole("button", { name, exact: true });
}

async function checkLineBoundary(page, surface, originalUi, key, name) {
  // Using page.keyboard preserves any focus loss. locator.press would refocus first.
  await pressKey(page, key);
  await expect(
    terminalInput(surface),
    `LINE_BOUNDARY_FOCUS: ${key} must keep terminal input focused`,
  ).toBeFocused();
  assert.equal(page.url(), originalUi.url, "Command arrows must keep the workspace open");
  assert.equal(await focusedPaneId(page), originalUi.paneId);
  await expect(terminalTabs(page)).toHaveCount(1);
  await expect(terminalTab(page, "Terminal 1")).toHaveAttribute("aria-selected", "true");
  await checkpoint(page, name, { key, terminalFocused: true });
}

async function prepareTerminal(page, pane, cwd, label, tabName) {
  const surface = pane.getByTestId("terminal-surface").filter({ visible: true });
  await surface.waitFor({ state: "visible", timeout: 30_000 });
  await pane.getByTestId("terminal-attach-loading").waitFor({ state: "hidden" });
  await terminalInput(surface).waitFor({ state: "attached" });
  const fixtureName = label.toLowerCase().replaceAll(" ", "-");
  const readyFile = `${fixtureName}-ready.txt`;
  const setupFile = `${fixtureName}.bashrc`;
  // DECSCUSR configures the cursor through ordinary terminal output. Bash keeps
  // user prompt plugins from replacing it before the recording checkpoint.
  // OSC 0 gives each tab a stable accessible name before asserting selection.
  const cursorSequence = recordVideo ? "\\033[1 q" : "";
  fs.writeFileSync(
    path.join(cwd, setupFile),
    `PS1='QA> '\nset -o emacs\nprintf '\\033[2J\\033[H${cursorSequence}\\033]0;%s\\007%s\\n' '${tabName}' '${label}'\nprintf 'ready:%s\\n' "$BASH_SILENCE_DEPRECATION_WARNING" > '${readyFile}'\n`,
  );
  // Bash owns setup so no keyboard input races its startup.
  await surface.click();
  await expect(terminalInput(surface)).toBeFocused();
  await page.keyboard.type(
    `BASH_SILENCE_DEPRECATION_WARNING=1 exec /bin/bash --noprofile --rcfile './${setupFile}' -i`,
  );
  await page.keyboard.press("Enter");
  await waitForValue(
    () => readShellFile(path.join(cwd, readyFile)),
    "ready:1\n",
    `${label} shell setup received the complete environment assignment`,
  );
  await expect(terminalInput(surface)).toBeFocused();
  await expect(terminalTab(pane, tabName)).toHaveAttribute("aria-selected", "true");
  return surface;
}

async function checkCommandEditing({ page, cwd, addCleanup }) {
  await runAction(page, "New terminal");
  const surface = await prepareTerminal(page, page, cwd, "SETUP_complete", "Terminal 1");
  const resultFile = path.join(cwd, "command-result.txt");
  addCleanup(() => {
    const output = readShellFile(resultFile);
    if (output !== null) fs.writeFileSync(path.join(artifactDir, "command-result.txt"), output);
  });
  if (recordVideo) {
    recording = await startTerminalKeyboardRecording({ page, artifactDir });
    addCleanup(() => recording.close());
  }
  await typeRecordedText(page, "echo one two");
  const originalUi = {
    url: page.url(),
    paneId: await focusedPaneId(page),
  };
  await checkpoint(page, "01-command-before-arrows", { typed: "echo one two" });
  await checkLineBoundary(page, surface, originalUi, "Meta+ArrowLeft", "02-command-left");
  await checkLineBoundary(
    page,
    surface,
    originalUi,
    "Meta+ArrowRight",
    "02b-command-right-unchanged",
  );
  await checkLineBoundary(page, surface, originalUi, "Meta+ArrowLeft", "02c-command-left-again");
  const prefix = "PASEO_PREFIX=ok; ";
  await typeRecordedText(page, prefix);
  await checkpoint(page, "02d-prefix-inserted", { typed: prefix });
  await checkLineBoundary(page, surface, originalUi, "Meta+ArrowRight", "03-command-right");
  const suffix = ' "$PASEO_PREFIX" | tee command-result.txt';
  await typeRecordedText(page, suffix);
  await checkpoint(page, "03b-suffix-inserted", { typed: suffix });
  await pressKey(page, "Enter");
  // Executing the edited line must produce the complete result through the real
  // shell. Missing either boundary changes the command or its output.
  await waitForValue(
    () => readShellFile(resultFile),
    "one two ok\n",
    "LINE_BOUNDARY_EDIT: the shell must execute the command with both inserted edits",
  );
  await checkpoint(page, "04-command-executed", { output: readShellFile(resultFile) });
}

async function focusedPaneId(page) {
  return page.evaluate(() =>
    document.activeElement
      ?.closest('[data-testid^="workspace-pane-"]')
      ?.getAttribute("data-testid"),
  );
}

async function checkTabSwitching(page, pane) {
  const startingTab = terminalTab(pane, "Terminal 3");
  const otherTab = terminalTab(pane, "Terminal 2");
  await expect(startingTab).toHaveAttribute("aria-selected", "true");
  await expect(otherTab).toHaveAttribute("aria-selected", "false");
  await pressKey(page, "Alt+Shift+[");
  await expect(otherTab).toHaveAttribute("aria-selected", "true");
  await expect(startingTab).toHaveAttribute("aria-selected", "false");
  await checkpoint(page, "04c-switch-tab-previous", { selectedTab: "Terminal 2" });
  await pressKey(page, "Alt+Shift+]");
  await expect(startingTab).toHaveAttribute("aria-selected", "true");
  await expect(otherTab).toHaveAttribute("aria-selected", "false");
  await checkpoint(page, "04d-switch-tab-next", { selectedTab: "Terminal 3" });
}

async function checkWorkspaceShortcuts({ page, cwd }) {
  const leftPaneId = await focusedPaneId(page);
  assert.equal(typeof leftPaneId, "string");
  await runAction(page, "Split pane right");
  const newPane = page
    .locator('[data-testid^="workspace-pane-"]')
    .filter({ has: page.getByTestId("workspace-new-tab-panel") })
    .filter({ visible: true });
  const rightPaneId = await newPane.getAttribute("data-testid");
  assert.notEqual(rightPaneId, leftPaneId);
  const leftPane = page.getByTestId(leftPaneId);
  const rightPane = page.getByTestId(rightPaneId);
  await runAction(page, "New terminal");
  await prepareTerminal(page, rightPane, cwd, "TERMINAL TWO", "Terminal 2");
  await expect(terminalTabs(rightPane)).toHaveCount(1);
  // Moving a pane's only tab collapses it. Keep a second tab for the return trip.
  await runAction(page, "New terminal");
  // The command menu can close before the new tab replaces the old visible surface.
  await expect(terminalTab(rightPane, "Terminal 2")).toHaveAttribute("aria-selected", "false");
  await prepareTerminal(page, rightPane, cwd, "TERMINAL THREE", "Terminal 3");
  await expect(terminalTabs(rightPane)).toHaveCount(2);
  await waitForValue(() => focusedPaneId(page), rightPaneId, "Right terminal focus");
  await recording?.showKey("Two panes ready; Terminal 3 is active");
  await checkpoint(page, "04b-shortcuts-ready", { focusedPaneId: rightPaneId });
  await checkTabSwitching(page, rightPane);

  await pressKey(page, "Meta+Shift+ArrowLeft");
  await waitForValue(() => focusedPaneId(page), leftPaneId, "Cmd+Shift+Left focuses left pane");
  await checkpoint(page, "05-focus-left", { focusedPaneId: leftPaneId });
  await pressKey(page, "Meta+Shift+ArrowRight");
  await waitForValue(() => focusedPaneId(page), rightPaneId, "Cmd+Shift+Right focuses right pane");
  await checkpoint(page, "06-focus-right", { focusedPaneId: rightPaneId });

  const tabName = "Terminal 3";
  await expect(terminalTab(rightPane, tabName)).toHaveAttribute("aria-selected", "true");
  await pressKey(page, "Meta+Alt+Shift+ArrowLeft");
  await expect(terminalTab(leftPane, tabName)).toBeVisible();
  await expect(terminalTab(rightPane, tabName)).toHaveCount(0);
  await checkpoint(page, "07-move-tab-left", { tabName, paneId: leftPaneId });
  await pressKey(page, "Meta+Alt+Shift+ArrowRight");
  await expect(terminalTab(rightPane, tabName)).toBeVisible();
  await expect(terminalTab(leftPane, tabName)).toHaveCount(0);
  await checkpoint(page, "08-move-tab-right", { tabName, paneId: rightPaneId });
}

async function prepareScenario(session) {
  const { page, serverId, workspaceId } = session;
  report.runtime = await page.evaluate(() => ({
    platform: window.paseoDesktop.platform,
    navigatorPlatform: navigator.platform,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
  }));
  assert.equal(report.runtime.platform, "darwin");
  assert.match(report.runtime.userAgent, /Electron\//);
  if (recordVideo) await setRecordingFontSize(page);
  const workspaceUrl = new URL(`/h/${serverId}/workspace/${workspaceId}`, page.url());
  await page.goto(workspaceUrl.href);
  await page.getByTestId("workspace-new-tab-button").first().waitFor({ timeout: 60_000 });
}

await runElectronScenario({ artifactDir, report, recordVideo }, async (session) => {
  await prepareScenario(session);
  await checkCommandEditing(session);
  await checkWorkspaceShortcuts(session);
});
