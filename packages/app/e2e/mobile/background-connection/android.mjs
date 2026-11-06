// Run with a connected host, notification permission granted, and the setting initially off.
// ANDROID_SERIAL=emulator-5554 node packages/app/e2e/mobile/background-connection/android.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const serial = process.env.ANDROID_SERIAL;
assert(serial, "Set ANDROID_SERIAL to the Android device used for this test");
const appId = process.env.PASEO_MOBILE_APP_ID ?? "sh.paseo.debug";
const label = process.env.PASEO_BACKGROUND_CONNECTION_LABEL ?? "Keep connection in background";
const session = "android-background-connection";
const env = {
  ...process.env,
  AGENT_DEVICE_STATE_DIR: resolve(".dev/agent-device-background-connection"),
};
const switchSelector = `role="switch" label=${JSON.stringify(label)}`;

function run(binary, args) {
  return execFileSync(binary, args, { env, encoding: "utf8", timeout: 180_000 });
}
function adb(...args) {
  return run("adb", ["-s", serial, ...args]);
}
function ad(...args) {
  const timeoutArgs = args[0] === "close" || args[0] === "wait" ? [] : ["--timeout", "180000"];
  return run("agent-device", [...args, "--session", session, ...timeoutArgs]);
}
function readSwitch() {
  const snapshot = JSON.parse(ad("snapshot", "-i", "--json"));
  assert.equal(snapshot.data.appBundleId, appId, "Snapshot must belong to the test app");
  const switches = snapshot.data.nodes.filter(
    (node) => node.kind === "switch" && node.label === label,
  );
  assert.equal(switches.length, 1, "The background connection switch must be visible");
  assert.equal(typeof switches[0].checked, "boolean", "The switch must expose its state");
  return switches[0].checked;
}
function readSystemState() {
  const services = adb("shell", "dumpsys", "activity", "services", appId);
  const service = services.match(
    /\* ServiceRecord\{[^\n]*sh\.paseo\.connection\.BackgroundConnectionService[\s\S]*?(?=\n  \* ServiceRecord|$)/,
  )?.[0];
  const notifications = adb("shell", "dumpsys", "notification", "--noredact");
  return {
    foregroundService: service !== undefined && service.includes("isForeground=true"),
    ongoingNotification: notifications
      .split("\n")
      .some(
        (line) =>
          line.includes("NotificationRecord(") &&
          line.includes(`pkg=${appId} `) &&
          line.includes("channel=paseo-server-connection") &&
          line.includes("ONGOING_EVENT") &&
          line.includes("FOREGROUND_SERVICE"),
      ),
  };
}
async function waitForState(enabled) {
  const deadline = Date.now() + 180_000;
  let observed;
  do {
    observed = { checked: readSwitch(), ...readSystemState() };
    if (
      observed.checked === enabled &&
      observed.foregroundService === enabled &&
      observed.ongoingNotification === enabled
    ) {
      return;
    }
    await delay(500);
  } while (Date.now() < deadline);
  assert.fail(
    `Expected the setting, foreground service and notification to be ${enabled}: ${JSON.stringify(observed)}`,
  );
}

ad("open", appId, "--platform", "android", "--serial", serial, "--no-test-ime");
try {
  ad("open", appId, "paseo://settings/general", "--platform", "android", "--no-test-ime");
  ad("wait", switchSelector, "90000");
  await waitForState(false);
  console.log("PASS: disabled setting has no foreground service or ongoing notification");

  for (const enabled of [true, false, true]) {
    ad("press", switchSelector);
    await waitForState(enabled);
    console.log(
      `PASS: setting ${enabled ? "enabled" : "disabled"} matches service and notification`,
    );
  }
} finally {
  try {
    if (readSwitch()) {
      ad("press", switchSelector);
      await waitForState(false);
    }
  } finally {
    ad("close");
  }
}
