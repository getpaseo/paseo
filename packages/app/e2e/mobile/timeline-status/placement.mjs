// Open an existing compact chat, with the keyboard closed, then interrupt its host connection.
// Hold that interruption externally (for example, stop a disposable SSH TCP forward).
// Leave the daemon running. This test observes the public reconnecting state.
// node placement.mjs <session> <platform> <coordinate-scale> <composer-label> <artifacts>
// coordinate-scale is screenshot pixels per layout point (Android density; iOS snapshots use 1).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , session, platform, coordinateScale, composerLabel, artifacts] = process.argv;
assert(
  session && ["android", "ios"].includes(platform) && composerLabel && artifacts,
  "Pass all five arguments",
);
const scale = Number(coordinateScale);
assert(scale > 0, "Pass a positive coordinate scale");
mkdirSync(artifacts, { recursive: true });
function ad(...args) {
  return execFileSync("agent-device", ["--session", session, "--platform", platform, ...args], {
    encoding: "utf8",
    timeout: 90_000,
  });
}
function capture(name) {
  const snapshot = ad("snapshot", "--raw", "--json");
  writeFileSync(path.join(artifacts, `${name}.json`), snapshot);
  ad("screenshot", path.join(artifacts, `${name}.png`));
  const nodes = JSON.parse(snapshot).data.nodes;
  const header = nodes.find((node) => node.identifier === "floating-header");
  const toast = nodes.find((node) => node.identifier === "agent-reconnecting-toast");
  assert(header?.rect && toast?.rect, "Measured header and reconnecting toast must be present");
  assert(toast.rect.height > 0 && toast.rect.width > 0, "Toast must have visible bounds");
  const gap = (toast.rect.y - header.rect.y - header.rect.height) / scale;
  assert(Math.abs(gap - 12) <= 1, `${name}: actual header-to-toast gap ${gap}, expected12 points`);
  return toast.rect.y / scale;
}

ad("wait", 'id="agent-reconnecting-toast"', "20000");
const closedTop = capture("keyboard-closed");
ad("press", `label=${JSON.stringify(composerLabel)}`);
const opened = ad("snapshot", "--raw", "--json");
const nodes = JSON.parse(opened).data.nodes;
assert(
  nodes.some(
    (node) => /keyboard/i.test(node.type ?? "") || /inputmethod/i.test(node.bundleId ?? ""),
  ),
  "Use a real visible software keyboard; open Android sessions with --no-test-ime",
);
const openTop = capture("keyboard-open");
assert(Math.abs(openTop - closedTop) <= 1, "Keyboard must not translate the toast");
console.log(
  "PASS: rendered reconnecting toast stays12 points below measured header, keyboard closed/open",
);
