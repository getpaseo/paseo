// Run a release build with a connected workspace open and the keyboard hidden.
// ANDROID_SERIAL=emulator-5574 node packages/app/e2e/mobile/fold/android.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const serial = process.env.ANDROID_SERIAL;
assert(serial, "Set ANDROID_SERIAL to a booted Android foldable emulator");
const appId = process.env.PASEO_MOBILE_APP_ID ?? "sh.paseo.debug";
const session = "android-fold";
const artifacts = resolve(".dev/agent-device-artifacts/android-fold");
const env = {
  ...process.env,
  AGENT_DEVICE_STATE_DIR: resolve(".dev/agent-device-android-fold"),
};
mkdirSync(artifacts, { recursive: true });

function run(binary, args) {
  return execFileSync(binary, args, { env, encoding: "utf8", timeout: 60_000 });
}
function adb(...args) {
  return run("adb", ["-s", serial, ...args]);
}
function ad(...args) {
  return run("agent-device", [...args, "--session", session]);
}
function pid() {
  return adb("shell", "pidof", appId).trim();
}
function open() {
  ad("open", appId, "--platform", "android", "--serial", serial, "--no-test-ime");
}
function stateId(name) {
  const states = adb("shell", "cmd", "device_state", "print-states");
  const match = states.match(new RegExp(`identifier=(\\d+), name='${name}'`));
  assert(match, `Emulator must expose the ${name} posture: ${states}`);
  return match[1];
}

async function expectLayout(posture) {
  const compact = posture === "CLOSED";
  const expectedId = compact ? "workspace-tab-switcher-trigger" : "workspace-tabs-scroll";
  const unexpectedId = compact ? "workspace-tabs-scroll" : "workspace-tab-switcher-trigger";
  const deadline = Date.now() + 15_000;
  let nodes = [];
  do {
    let data;
    try {
      ({ data } = JSON.parse(ad("snapshot", "-i", "--json")));
    } catch (error) {
      // During display handoff Android briefly has no capturable app window.
      if (!error.stdout?.includes("insufficient foreground app content")) throw error;
      await delay(200);
      continue;
    }
    assert.equal(data.appBundleId, appId, "Snapshot must belong to Paseo");
    nodes = data.nodes;
    if (
      nodes.some((node) => node.identifier === expectedId) &&
      !nodes.some((node) => node.identifier === unexpectedId)
    ) {
      writeFileSync(resolve(artifacts, `${posture}.json`), JSON.stringify(data, null, 2));
      console.log(`PASS: ${posture} uses ${compact ? "compact" : "wide"} workspace controls`);
      return;
    }
    await delay(200);
  } while (Date.now() < deadline);
  writeFileSync(resolve(artifacts, `${posture}-failure.json`), JSON.stringify(nodes, null, 2));
  writeFileSync(
    resolve(artifacts, "native-failure.txt"),
    adb("shell", "dumpsys", "activity", "top"),
  );
  assert.fail(`${posture}: expected ${expectedId}, without ${unexpectedId}`);
}

const closed = stateId("CLOSED");
const opened = stateId("OPENED");
const initialState = adb("shell", "cmd", "device_state", "state").match(
  /Committed state: DeviceState\{identifier=(\d+)/,
)?.[1];
assert(initialState, "Could not read the initial fold state");

try {
  adb("shell", "cmd", "device_state", "state", opened);
  open();
  await expectLayout("OPENED");
  const initialPid = pid();
  for (const [posture, id] of [
    ["CLOSED", closed],
    ["OPENED", opened],
  ]) {
    adb("shell", "input", "keyevent", "KEYCODE_HOME");
    adb("shell", "cmd", "device_state", "state", id);
    // Resume immediately: waiting for configuration delivery hides the regression.
    open();
    await expectLayout(posture);
    assert.equal(pid(), initialPid, "Fold/resume must preserve the app process");
  }
} finally {
  adb("shell", "cmd", "device_state", "state", initialState);
  ad("close");
}
