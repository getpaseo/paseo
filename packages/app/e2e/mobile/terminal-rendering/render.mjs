import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { PNG } from "pngjs";
import {
  checkPartialSelection,
  checkTerminalScreenshot,
  selectionTarget,
  writeOverlay,
} from "./check.mjs";
import { fixtureOutput } from "./fixture.mjs";

// Renders the fixture in a real Paseo terminal and checks the screenshot with `check.mjs`, then
// selects one cell of a conjunct and checks a second screenshot.
//
// Preconditions: the app runs the build being verified against a daemon on the same host as
// this script, and shows an idle, focused terminal with an empty shell prompt.
//
//   PLATFORM=android ANDROID_SERIAL=emulator-5554 node e2e/mobile/terminal-rendering/render.mjs
//   PLATFORM=ios IOS_DEVICE="iPhone 17" node e2e/mobile/terminal-rendering/render.mjs
const platform = process.env.PLATFORM ?? "android";
const appId = process.env.PASEO_TERMINAL_RENDERING_APP_ID ?? "sh.paseo.debug";
const label = process.env.PASEO_TERMINAL_RENDERING_LABEL ?? "run";
const session = process.env.AGENT_DEVICE_SESSION ?? `terminal-rendering-${platform}`;
const artifacts = resolve(
  process.env.PASEO_TERMINAL_RENDERING_ARTIFACTS ??
    resolve(homedir(), ".paseo/artifacts/terminal-rendering", platform),
  label,
);
const fixtureDir = process.env.PASEO_TERMINAL_RENDERING_FIXTURE_DIR ?? tmpdir();
// iOS simulators screenshot at one pixel per point unless asked; glyph identity needs the
// device's real density. Android screenshots are always in device pixels.
const screenshotArgs =
  platform === "ios"
    ? ["--pixel-density", process.env.PASEO_TERMINAL_RENDERING_PIXEL_DENSITY ?? "3"]
    : [];
const env = {
  ...process.env,
  AGENT_DEVICE_STATE_DIR:
    process.env.AGENT_DEVICE_STATE_DIR ??
    resolve(homedir(), ".paseo/artifacts/terminal-rendering/device-state"),
};
mkdirSync(artifacts, { recursive: true });

function ad(...args) {
  return execFileSync("agent-device", [...args, "--session", session], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function deviceArgs() {
  if (platform === "android") {
    return [
      "--platform",
      "android",
      ...(process.env.ANDROID_SERIAL ? ["--serial", process.env.ANDROID_SERIAL] : []),
    ];
  }
  return [
    "--platform",
    "ios",
    ...(process.env.IOS_DEVICE ? ["--device", process.env.IOS_DEVICE] : []),
  ];
}

function snapshotNodes() {
  return JSON.parse(ad("snapshot", "--json")).data.nodes;
}

function rowNodes(nodes) {
  const rows = new Map();
  for (const node of nodes) {
    const match = /^terminal-row-(\d+)$/.exec(node.identifier ?? "");
    if (match && node.rect) rows.set(Number(match[1]), node);
  }
  return rows;
}

/**
 * Taps a control at its center. On iOS the keyboard toolbar is a full-screen accessibility node
 * listed after the key bar, so pressing by selector reports the keys as covered.
 */
function pressControl(id) {
  const node = JSON.parse(ad("snapshot", "-i", "--json")).data.nodes.find(
    (candidate) => candidate.identifier === id,
  );
  assert.ok(node?.rect, `No ${id} control on screen`);
  const { x, y, width, height } = node.rect;
  ad("press", String(Math.round(x + width / 2)), String(Math.round(y + height / 2)));
}

async function runCommand(command) {
  ad("type", command, "--delay-ms", "0");
  pressControl("terminal-key-enter");
  await setTimeout(2_000);
}

async function terminalSize() {
  await runCommand("clear; stty size");
  for (const node of snapshotNodes()) {
    const match = /^(\d+) (\d+)$/.exec((node.label ?? "").trim());
    if (match && (node.identifier ?? "").startsWith("terminal-row-")) {
      return { rows: Number(match[1]), columns: Number(match[2]) };
    }
  }
  throw new Error("No terminal row showed the `stty size` output");
}

ad("open", appId, ...deviceArgs());
const controls = JSON.parse(ad("snapshot", "-i", "--json")).data.nodes;
const hasControl = (id) => controls.some((node) => node.identifier === id);
assert.ok(hasControl("terminal-keyboard-toggle"), "Open a terminal first");
if (!hasControl("terminal-key-enter")) pressControl("terminal-keyboard-toggle");

const size = await terminalSize();
const fixturePath = resolve(fixtureDir, "paseo-terminal-rendering.txt");
const scriptPath = resolve(fixtureDir, "paseo-terminal-rendering.sh");
writeFileSync(fixturePath, fixtureOutput(size.columns));
writeFileSync(scriptPath, `printf '\\033[2J\\033[3J\\033[H'; cat '${fixturePath}'; sleep 120\n`);
await runCommand(`sh ${scriptPath}`);

const nodes = snapshotNodes();
const screenshotPath = resolve(artifacts, "terminal.png");
ad("screenshot", screenshotPath, ...screenshotArgs);
const png = PNG.sync.read(readFileSync(screenshotPath));
// Snapshot rects are in points on iOS and pixels on Android; the checks work in screenshot pixels.
const scale = png.width / Math.max(...nodes.map((node) => node.rect?.width ?? 0));
const toPixels = ({ x, y, width, height }) => ({
  x: x * scale,
  y: y * scale,
  width: width * scale,
  height: height * scale,
});
const rows = rowNodes(nodes);
const rects = new Map([...rows].map(([index, node]) => [index, toPixels(node.rect)]));
const { grid, failures, slots } = await checkTerminalScreenshot({ png, size, rows: rects });

// Long-press selects the conjunct as a word; dragging back from its second cell leaves the first.
const target = await selectionTarget({ size });
const targetRect = rects.get(target.row);
assert.ok(targetRect, "The select line is not on screen");
const y = Math.round((targetRect.y + targetRect.height / 2) / scale);
const cellX = (offset) => Math.round((grid.left + (target.col + offset) * grid.cellWidth) / scale);
ad("longpress", String(cellX(0.5)), String(y), "800");
ad("gesture", "pan", String(cellX(1.75)), String(y), String(cellX(0.5) - cellX(1.75)), "0", "600");
const selectionPath = resolve(artifacts, "selection.png");
ad("screenshot", selectionPath, ...screenshotArgs);
const selectionFailures = checkPartialSelection({
  png: PNG.sync.read(readFileSync(selectionPath)),
  rows: rects,
  grid,
  target,
});
for (const failure of selectionFailures) failures.push({ line: "select", ...failure });
// A tap clears the selection; it would otherwise survive into the next run's screenshot.
const lastRect = rects.get(size.rows - 1);
if (lastRect) {
  ad("press", String(cellX(4)), String(Math.round((lastRect.y + lastRect.height / 2) / scale)));
}
try {
  pressControl("terminal-key-ctrl");
  ad("type", "c", "--delay-ms", "0");
} catch (error) {
  console.warn(`Could not interrupt the fixture: ${error.message}`);
}

writeOverlay(png, slots, resolve(artifacts, "overlay.png"));
const report = {
  platform,
  label,
  size,
  grid,
  checkedClusters: slots.length,
  failures,
  rows: [...rows.keys()].map((index) => ({
    index,
    label: rows.get(index).label,
    rect: rects.get(index),
  })),
};
writeFileSync(resolve(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const byLine = Map.groupBy(failures, (failure) => failure.line);
console.log(
  `${label}: ${slots.length} clusters checked, ${failures.length} failures (${artifacts})`,
);
for (const [line, list] of byLine) {
  console.log(
    `  ${line}: ${list.map((failure) => `${failure.kind}@${failure.col ?? "-"}${failure.char ? `(${failure.char})` : ""}`).join(" ")}`,
  );
}
process.exitCode = failures.length === 0 ? 0 : 1;
