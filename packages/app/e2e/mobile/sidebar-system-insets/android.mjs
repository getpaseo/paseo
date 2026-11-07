// Open a connected host with the wide sidebar visible, keyboard closed, and
// three-button navigation enabled on an Android tablet. Run against a fresh build:
// node packages/app/e2e/mobile/sidebar-system-insets/android.mjs <session> <adb-serial>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [, , session, serial] = process.argv;
assert(session && serial, "Pass the agent-device session and adb serial");
const windowState = execFileSync("adb", ["-s", serial, "shell", "dumpsys", "window"], {
  encoding: "utf8",
  timeout: 10_000,
});
const navBar = windowState.match(/type=navigationBars frame=\[0,(\d+)\]\[\d+,\d+\] visible=true/);
assert(navBar, "A visible bottom navigation bar is required");
assert(!/type=ime .*visible=true/.test(windowState), "Close the keyboard first");
const navigationTop = Number(navBar[1]);
const { data } = JSON.parse(
  execFileSync("agent-device", ["snapshot", "--raw", "--json", "--session", session], {
    encoding: "utf8",
    timeout: 60_000,
  }),
);
const focusedApp = windowState.match(/mCurrentFocus=.*? u\d+ ([^/\s]+)\//)?.[1];
assert.equal(
  focusedApp,
  data.appBundleId,
  "Snapshot must belong to the focused app on this device",
);
for (const id of [
  "sidebar-add-project",
  "sidebar-hosts-trigger",
  "sidebar-help",
  "sidebar-settings",
]) {
  const button = data.nodes.find((node) => node.identifier === id);
  assert(button?.rect, `${id} must be visible above the system navigation bar`);
  const bottom = button.rect.y + button.rect.height;
  assert(bottom <= navigationTop, `${id} ends at ${bottom}, below navigation top ${navigationTop}`);
  console.log(`PASS: ${id} bottom=${bottom}, navigationTop=${navigationTop}`);
}
