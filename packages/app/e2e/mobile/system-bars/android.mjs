// Open Settings > Appearance in a native Android app loaded from this checkout.
// AGENT_DEVICE_STATE_DIR=<state-dir> node packages/app/e2e/mobile/system-bars/android.mjs <session> <adb-serial> <app-id>
// Requires English UI and a dedicated emulator. Leaves System theme and light OS appearance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const [, , session, serial, appId] = process.argv;
assert(session && serial && appId, "Pass the agent-device session, adb serial, and app ID");

function ad(...args) {
  return execFileSync("agent-device", [...args, "--session", session], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

function windowState() {
  const state = execFileSync("adb", ["-s", serial, "shell", "dumpsys", "window"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert(state.match(/mCurrentFocus=.*\n/)?.[0].includes(`${appId}/`), "App must be focused");
  const regions = state.match(/mLastStatusBarAppearanceRegions=\s*\n([^\n]+)/)?.[1];
  assert(regions, "Android must report the status-bar appearance region");
  return regions.includes("LIGHT_STATUS_BARS");
}

async function expectDarkIcons(expected, context) {
  const deadline = Date.now() + 5_000;
  do {
    if (windowState() === expected) {
      console.log(`PASS: ${context}`);
      return;
    }
    await delay(100);
  } while (Date.now() < deadline);
  assert.equal(windowState(), expected, context);
}

function selectTheme(theme) {
  const current = ad("snapshot", "-i").match(/"Theme: ([^"]+)"/)?.[1];
  assert(current, "Start on Settings > Appearance");
  ad("press", `label="Theme: ${current}"`, "--settle");
  ad("press", `label="${theme}"`, "--settle");
  ad("wait", "text", `Theme: ${theme}`, "5000");
}

ad("settings", "appearance", "light");
selectTheme("Light");
await expectDarkIcons(true, "Light app theme uses dark status icons");
selectTheme("Dark");
await expectDarkIcons(false, "Dark app theme uses light status icons");
selectTheme("System");
await expectDarkIcons(true, "System theme starts with dark icons on light OS appearance");
ad("settings", "appearance", "dark");
await expectDarkIcons(
  false,
  "System theme follows an OS change to dark without reopening settings",
);
ad("settings", "appearance", "light");
await expectDarkIcons(true, "System theme follows an OS change back to light");
