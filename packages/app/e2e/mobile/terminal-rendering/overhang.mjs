import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { PNG } from "pngjs";
import { countInk, measureGrid } from "./check.mjs";
import { RULER_CELLS } from "./fixture.mjs";

// Checks ink that leaves its row: stacked marks above and below a row reach into the rows next to
// it. The script prints such rows, then in one update writes into two rows that hold another row's
// overhang and erases two rows whose overhang reaches a blank row. The overhang must be drawn
// before the update, stay drawn in the written rows, and leave no ink behind the erased rows.
//
// Preconditions are the same as `render.mjs`: the app runs the build being verified against a
// daemon on the same host as this script, and shows an idle, focused terminal with an empty prompt.
//
//   PLATFORM=android ANDROID_SERIAL=emulator-5554 node e2e/mobile/terminal-rendering/overhang.mjs
//   PLATFORM=ios IOS_DEVICE="iPhone 17" node e2e/mobile/terminal-rendering/overhang.mjs
const platform = process.env.PLATFORM ?? "android";
const appId = process.env.PASEO_TERMINAL_RENDERING_APP_ID ?? "sh.paseo.debug";
const label = process.env.PASEO_TERMINAL_RENDERING_LABEL ?? "overhang";
const session = process.env.AGENT_DEVICE_SESSION ?? `terminal-rendering-${platform}`;
const artifacts = resolve(
  process.env.PASEO_TERMINAL_RENDERING_ARTIFACTS ??
    resolve(homedir(), ".paseo/artifacts/terminal-rendering", platform),
  label,
);
const fixtureDir = process.env.PASEO_TERMINAL_RENDERING_FIXTURE_DIR ?? tmpdir();
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

/** Marks stacked below the row: Arabic dots, rings below `g`, a vowel sign below a consonant. */
const BELOW = "پپپ ييي ججج g̥̥̥̥ कृ";
/** Marks stacked above the row: accents over `e` and `s`, candrabindu, om. */
const ABOVE = "é́́́ ŝ̂̂ कँ ॐ";
/** The marks rows stay left of this column; the update writes at it, outside the checked boxes. */
const CHECKED_COLUMNS = 26;
const WRITE_COLUMN = 30;
/** 0-based rows. Each source row's overhang reaches the row next to it. */
const SOURCES = [
  { row: 2, text: BELOW, overhangRow: 3, update: "write" },
  { row: 6, text: ABOVE, overhangRow: 5, update: "erase" },
  { row: 9, text: BELOW, overhangRow: 10, update: "erase" },
  { row: 13, text: ABOVE, overhangRow: 12, update: "write" },
];
const PARK_ROW = 16;

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

function pressControl(id) {
  const node = JSON.parse(ad("snapshot", "-i", "--json")).data.nodes.find(
    (candidate) => candidate.identifier === id,
  );
  assert.ok(node?.rect, `No ${id} control on screen`);
  const { x, y, width, height } = node.rect;
  ad("press", String(Math.round(x + width / 2)), String(Math.round(y + height / 2)));
}

async function pressEnter() {
  pressControl("terminal-key-enter");
  await setTimeout(2_000);
}

async function runCommand(command) {
  ad("type", command, "--delay-ms", "0");
  await pressEnter();
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

function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Prints the source rows, waits for Enter, applies the update, and waits for Enter again. */
function fixtureScript() {
  const at = (row, col) => `\\033[${row + 1};${col + 1}H`;
  const print = (row, text) => `printf '${at(row, 0)}%s' ${shellQuote(text)}`;
  const update = SOURCES.map((source) =>
    source.update === "write"
      ? `${at(source.overhangRow, WRITE_COLUMN)}x`
      : `${at(source.row, 0)}\\033[2K`,
  ).join("");
  return [
    "stty -echo",
    "printf '\\033[2J\\033[3J'",
    print(0, "█".repeat(RULER_CELLS)),
    ...SOURCES.map((source) => print(source.row, source.text)),
    `printf '${at(PARK_ROW, 0)}'`,
    "read -r _",
    `printf '${update}${at(PARK_ROW, 0)}'`,
    "read -r _",
    "stty echo",
    "",
  ].join("\n");
}

function screenshot(name) {
  const path = resolve(artifacts, name);
  ad("screenshot", path, ...screenshotArgs);
  return PNG.sync.read(readFileSync(path));
}

/** Pixels in `box` where the two screenshots differ by more than the ink threshold. */
function changedPixels(before, after, box) {
  const difference = new PNG({ width: before.width, height: before.height });
  for (let index = 0; index < before.data.length; index += 1) {
    difference.data[index] = Math.abs(before.data[index] - after.data[index]);
  }
  return countInk(difference, box, [0, 0, 0]);
}

ad("open", appId, ...deviceArgs());
const controls = JSON.parse(ad("snapshot", "-i", "--json")).data.nodes;
const hasControl = (id) => controls.some((node) => node.identifier === id);
assert.ok(hasControl("terminal-keyboard-toggle"), "Open a terminal first");
if (!hasControl("terminal-key-enter")) pressControl("terminal-keyboard-toggle");

const size = await terminalSize();
assert.ok(
  size.rows > PARK_ROW && size.columns > WRITE_COLUMN,
  `Terminal too small: ${JSON.stringify(size)}`,
);
const scriptPath = resolve(fixtureDir, "paseo-terminal-overhang.sh");
writeFileSync(scriptPath, fixtureScript());
await runCommand(`sh ${scriptPath}`);

const nodes = snapshotNodes();
const before = screenshot("before.png");
await pressEnter();
const after = screenshot("after.png");
await pressEnter();

// Snapshot rects are in points on iOS and pixels on Android; the checks work in screenshot pixels.
const scale = before.width / Math.max(...nodes.map((node) => node.rect?.width ?? 0));
const ruler = nodes.find((node) => node.identifier === "terminal-row-0")?.rect;
assert.ok(ruler, "The ruler row is not exposed as terminal-row-0");
const rulerRect = {
  x: ruler.x * scale,
  y: ruler.y * scale,
  width: ruler.width * scale,
  height: ruler.height * scale,
};
const grid = measureGrid(before, rulerRect);
const rowBox = (row) => ({
  left: grid.left,
  right: grid.left + CHECKED_COLUMNS * grid.cellWidth,
  top: rulerRect.y + row * rulerRect.height,
  bottom: rulerRect.y + (row + 1) * rulerRect.height,
});

/** Measures one source row's overhang before and after the update. */
function measure(source) {
  const box = rowBox(source.overhangRow);
  const overhangBefore = countInk(before, box, grid.background);
  if (source.update === "write") {
    const changedAfterWrite = changedPixels(before, after, box);
    const failures = [
      ...(overhangBefore === 0 ? ["overhang-not-drawn"] : []),
      ...(changedAfterWrite > 0 ? ["overhang-lost-after-write"] : []),
    ];
    return { ...source, overhangBefore, changedAfterWrite, failures };
  }
  const inkAfterErase = countInk(after, box, grid.background);
  const sourceInkAfterErase = countInk(after, rowBox(source.row), grid.background);
  const failures = [
    ...(overhangBefore === 0 ? ["overhang-not-drawn"] : []),
    ...(inkAfterErase > 0 ? ["overhang-left-after-erase"] : []),
    ...(sourceInkAfterErase > 0 ? ["source-left-after-erase"] : []),
  ];
  return { ...source, overhangBefore, inkAfterErase, sourceInkAfterErase, failures };
}

const results = SOURCES.map(measure);

const report = { platform, label, size, grid, rulerRect, results };
writeFileSync(resolve(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
const failures = results.flatMap((result) =>
  result.failures.map((failure) => `row ${result.overhangRow}: ${failure}`),
);
console.log(`${label}: ${failures.length} failures (${artifacts})`);
for (const result of results) {
  console.log(
    `  row ${result.row} -> ${result.overhangRow} (${result.update}): overhang ${result.overhangBefore}` +
      (result.update === "write"
        ? `, changed after write ${result.changedAfterWrite}`
        : `, left after erase ${result.inkAfterErase}, source left ${result.sourceInkAfterErase}`),
  );
}
for (const failure of failures) console.log(`  ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
