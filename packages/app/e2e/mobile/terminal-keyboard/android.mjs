import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

// Open an idle terminal with an empty prompt and hide its keyboard before running.
// The app must already run the checkout/build being verified against a real daemon.
const appId = process.env.PASEO_TERMINAL_KEYBOARD_APP_ID ?? "sh.paseo.debug";
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const artifacts = resolve(".dev/agent-device-artifacts/terminal-keyboard-android");
const session = "terminal-keyboard-android";
const env = {
  ...process.env,
  AGENT_DEVICE_STATE_DIR: resolve(".dev/agent-device-terminal-keyboard"),
};
mkdirSync(artifacts, { recursive: true });

function run(binary, args) {
  return execFileSync(binary, args, { env, encoding: "utf8", timeout: 30_000 });
}
function ad(...args) {
  return run("agent-device", [...args, "--session", session]);
}
function adb(...args) {
  return run("adb", ["-s", serial, ...args]);
}
function keyboardState() {
  const state = adb("shell", "dumpsys", "input_method");
  const view = state.match(/^  mServedView=(.+)$/m)?.[1] ?? "";
  return {
    shown: /^  mInputShown=true$/m.test(state),
    // The native object identity survives layout/flag changes but not a remount.
    input: view.match(/ReactEditText\{(\w+)/)?.[1] ?? null,
  };
}
async function waitForKeyboard(shown) {
  let stable = 0;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = keyboardState();
    stable = state.shown === shown ? stable + 1 : 0;
    if (stable === 3) return state;
    await setTimeout(100);
  }
  throw new Error(`Keyboard did not settle at shown=${shown}`);
}
function keyboardShift() {
  const state = adb("shell", "dumpsys", "window");
  const ime = state.match(/type=ime frame=\[0,(\d+)\].*visible=true/);
  const navigation = state.match(/type=navigationBars frame=\[0,(\d+)\]/);
  assert.ok(ime && navigation, "Expected a docked keyboard and navigation bar");
  return Number(navigation[1]) - Number(ime[1]);
}
function imeEvents() {
  return adb("logcat", "-d", "-v", "threadtime", "ImeTracker:I", "*:S")
    .split("\n")
    .filter((line) => line.includes(`${appId}:`));
}
function tap(rect, shift) {
  ad(
    "press",
    String(Math.round(rect.x + rect.width / 2)),
    String(Math.round(rect.y + rect.height / 2 - shift)),
  );
}

let toggle;
try {
  ad("open", appId, "--platform", "android", "--serial", serial, "--no-test-ime");
  assert.equal(keyboardState().shown, false, "Start with the terminal keyboard hidden");
  // Accessibility snapshots can hang with a real IME open. Measure the controls
  // while hidden, then project them by Android's actual docked-keyboard inset.
  const snapshot = JSON.parse(ad("snapshot", "-i", "--json"));
  const rectFor = (id) => {
    const node = snapshot.data.nodes.find((candidate) => candidate.identifier === id);
    assert.ok(node?.rect, `Open a terminal first: missing ${id}`);
    return node.rect;
  };
  toggle = rectFor("terminal-keyboard-toggle");
  const controls = ["ctrl", "ctrl", "esc", "enter"].map((key) => ({
    key,
    rect: rectFor(`terminal-key-${key}`),
  }));
  tap(toggle, 0);
  const baseline = await waitForKeyboard(true);
  assert.notEqual(baseline.input, null, "Expected the native terminal input to own the IME");
  const shift = keyboardShift();
  const before = new Set(imeEvents());
  ad("screenshot", resolve(artifacts, "before.png"));

  for (const { key, rect } of controls) {
    tap(rect, shift);
    const after = await waitForKeyboard(true);
    const events = imeEvents().filter((line) => !before.has(line));
    writeFileSync(resolve(artifacts, "ime-events.log"), events.join("\n"));
    writeFileSync(
      resolve(artifacts, "focus.json"),
      JSON.stringify({ key, baseline, after }, null, 2),
    );
    assert.equal(after.input, baseline.input, `${key} replaced the focused native input`);
    assert.deepEqual(
      events.filter((line) => /onRequestHide|onRequestShow/.test(line)),
      [],
      `${key} cycled the software keyboard`,
    );
  }
  ad("screenshot", resolve(artifacts, "after.png"));
  console.log("PASS: Ctrl, Esc and Enter preserve the native input without IME hide/show requests");
} finally {
  if (toggle && keyboardState().shown) {
    tap(toggle, keyboardShift());
    await waitForKeyboard(false);
  }
  ad("close");
  run("agent-device", ["daemon", "stop", "--clean"]);
}
