import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

// Open Usage with a fixture whose cards fit without scrolling before running.
// A same-slot drop must release the list's recognizer so a body swipe moves the sheet.
const serial = process.env.ANDROID_SERIAL;
assert.ok(serial, "Set ANDROID_SERIAL to the device owned by this test");
const session = process.env.PASEO_DEVICE_SESSION ?? "usage-drag-regression";
const artifacts = resolve(".artifacts/usage-drag-regression");
mkdirSync(artifacts, { recursive: true });
function ad(...args) {
  return execFileSync(
    "agent-device",
    [...args, "--platform", "android", "--serial", serial, "--session", session],
    { encoding: "utf8", timeout: 30_000 },
  );
}
function adb(...args) {
  return execFileSync("adb", ["-s", serial, ...args], { timeout: 30_000 });
}
function snapshot() {
  return JSON.parse(ad("snapshot", "--json")).data.nodes;
}
function touch(kind, x, y) {
  adb("shell", "input", "motionevent", kind, String(Math.round(x)), String(Math.round(y)));
}
try {
  ad("open", process.env.PASEO_MOBILE_APP_ID ?? "sh.paseo.debug");
  const nodes = snapshot();
  writeFileSync(resolve(artifacts, "before.json"), JSON.stringify(nodes));
  const handle = nodes.find((node) => node.identifier === "usage-card-drag-handle");
  const list = nodes.find((node) => node.identifier === "usage-list");
  assert.ok(handle?.rect && list?.rect, "Open Usage with a visible card handle");
  const x = handle.rect.x + handle.rect.width / 2;
  const y = handle.rect.y + handle.rect.height / 2;
  touch("DOWN", x, y);
  await setTimeout(600);
  touch("MOVE", x, y + 60);
  await setTimeout(200);
  touch("MOVE", x, y + 90);
  touch("MOVE", x, y + 60);
  ad("screenshot", resolve(artifacts, "dragging.png"));
  touch("UP", x, y + 60);
  await setTimeout(2000);
  ad("screenshot", resolve(artifacts, "dropped.png"));
  const swipeX = list.rect.x + list.rect.width / 2;
  touch("DOWN", swipeX, y + 80);
  for (let offset = 90; offset <= 500; offset += 10) {
    touch("MOVE", swipeX, y + offset);
  }
  const during = snapshot();
  writeFileSync(resolve(artifacts, "during.json"), JSON.stringify(during));
  ad("screenshot", resolve(artifacts, "during.png"));
  touch("UP", swipeX, y + 500);
  await setTimeout(1500);
  const after = snapshot();
  writeFileSync(resolve(artifacts, "after.json"), JSON.stringify(after));
  ad("screenshot", resolve(artifacts, "after.png"));
  const beforeSheet = nodes.find((node) => node.label === "Bottom sheet handle");
  const afterSheet = during.find((node) => node.label === "Bottom sheet handle");
  assert.ok(beforeSheet?.rect, "Usage must start as a sheet");
  assert.ok(
    !afterSheet || afterSheet.rect.y > beforeSheet.rect.y + 50,
    "A body swipe after a same-slot drop must move the sheet",
  );
} finally {
  ad("close");
}
