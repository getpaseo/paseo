// Run against an Android dev client serving this checkout, with a real software keyboard.
// node packages/app/e2e/mobile/appearance-keyboard/android.mjs <session> <metro-url> <server-id> [app-id]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [, , session, metroUrl, serverId, appId = "sh.paseo.debug"] = process.argv;
assert(
  session && metroUrl && serverId,
  "Pass the agent-device session, Metro URL and connected host ID",
);
const artifacts = resolve(".dev/agent-device-artifacts/appearance-keyboard-android");
mkdirSync(artifacts, { recursive: true });

function ad(...args) {
  return execFileSync("agent-device", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

function evaluate(expression) {
  return ad("cdp", "runtime", "eval", "--expr", expression, "--json");
}

// Read the mounted app's public React Native APIs through Metro. Accessibility
// snapshots with Gboard open can block while waiting for an idle hierarchy.
const reactNative = `Array.from(__r.getModules().values()).find(
  m => m.verboseName?.endsWith("/react-native/index.js")
).publicModule.exports`;

function measureFocusedInput() {
  evaluate(`(() => {
    const rn = ${reactNative};
    globalThis.__appearanceKeyboardMeasurement = null;
    rn.TextInput.State.currentlyFocusedInput()?.measureInWindow((x, y, width, height) => {
      globalThis.__appearanceKeyboardMeasurement = JSON.stringify({
        x, y, width, height,
        statusBarHeight: rn.StatusBar.currentHeight,
        scale: rn.PixelRatio.get(),
        keyboard: rn.Keyboard.metrics(),
      });
    });
  })()`);
  const value = JSON.parse(evaluate("globalThis.__appearanceKeyboardMeasurement"));
  return value ? JSON.parse(value) : null;
}

async function waitForFocusedInput() {
  let measurement;
  let previous;
  let stable = 0;
  const deadline = Date.now() + 30_000;
  do {
    measurement = measureFocusedInput();
    const current = measurement?.keyboard
      ? [measurement.y, measurement.height, measurement.keyboard.screenY].map(Math.round).join(",")
      : null;
    stable = measurement?.keyboard && current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= 3) break;
    await delay(150);
  } while (Date.now() < deadline);

  assert(stable >= 3, `Focused input and keyboard must settle: ${JSON.stringify(measurement)}`);
  return measurement;
}

ad("open", appId, "--platform", "android", "--no-test-ime");
const targets = ad("cdp", "target", "list", "--url", metroUrl)
  .split("\n")
  .filter((line) => line.includes(appId));
assert.equal(targets.length, 1, "Connect only the test app to this Metro server");
ad("cdp", "target", "select", targets[0].split(/\s+/)[0]);

try {
  evaluate(`(${reactNative}).Keyboard.dismiss()`);
  ad("open", appId, "paseo://settings", "--platform", "android", "--no-test-ime");
  ad("wait", "text", "Appearance", "5000");
  ad("open", appId, "paseo://settings/appearance", "--platform", "android", "--no-test-ime");
  ad("wait", "text", "Code size", "5000");
  const snapshot = JSON.parse(ad("snapshot", "-i", "--json"));
  const numericFields = snapshot.data.nodes.filter(
    (node) => node.type === "android.widget.EditText" && /^\d+$/.test(node.value ?? ""),
  );
  assert.equal(numericFields.length, 3, "All three font sizes must be visible without scrolling");
  ad("screenshot", resolve(artifacts, "before-keyboard.png"));
  // Appearance orders Interface size, Content size, then Code size.
  ad("press", `@${numericFields[2].ref}`);

  const measurement = await waitForFocusedInput();
  // Android measureInWindow excludes the status bar, Keyboard.metrics uses screen coordinates.
  const inputBottom = measurement.y + measurement.height + measurement.statusBarHeight;
  const keyboardTop = measurement.keyboard.screenY;
  console.log(JSON.stringify({ inputBottom, keyboardTop, measurement }));
  ad("screenshot", resolve(artifacts, "keyboard.png"));
  assert(
    inputBottom <= keyboardTop + 1 / measurement.scale,
    "Code size must be fully visible above the number keyboard (within one physical pixel)",
  );
  console.log("PASS: focusing Code size reveals the whole field above the keyboard");

  evaluate(`(${reactNative}).Keyboard.dismiss()`);
  ad(
    "open",
    appId,
    `paseo://settings/hosts/${encodeURIComponent(serverId)}/plugins`,
    "--platform",
    "android",
    "--no-test-ime",
  );
  ad("wait", "text", "Plugin source", "5000");
  const plugins = JSON.parse(ad("snapshot", "-i", "--json"));
  const source = plugins.data.nodes.find((node) => node.type === "android.widget.EditText");
  assert(source, "The connected host must support installing plugins from source");
  ad("press", `@${source.ref}`);
  ad("type", "qa-source");
  const pluginMeasurement = await waitForFocusedInput();
  // A FormTextInput draws its border and padding on the native input's parent.
  // Measure that visible frame, rather than accepting only the text as visible.
  const hierarchy = JSON.parse(ad("snapshot", "--json")).data.nodes;
  const focused = hierarchy.find((node) => node.type === "android.widget.EditText" && node.focused);
  assert(focused, "Plugin source must remain focused after typing");
  assert.equal(focused.value, "qa-source", "Typed source must remain in the focused field");
  const frame = hierarchy.find((node) => node.index === focused.parentIndex);
  assert(frame, "The source input's visible frame must be present in the native hierarchy");
  assert(
    frame.rect.height > focused.rect.height,
    "Measure the surrounding frame, including padding",
  );
  const frameBottom = frame.rect.y + frame.rect.height;
  const pluginKeyboardTop = pluginMeasurement.keyboard.screenY * pluginMeasurement.scale;
  console.log(JSON.stringify({ frameBottom, keyboardTop: pluginKeyboardTop, frame: frame.rect }));
  ad("screenshot", resolve(artifacts, "plugin-source-keyboard.png"));
  assert(
    frameBottom <= pluginKeyboardTop + 1,
    "Plugin source frame must be fully visible above the keyboard (within one physical pixel)",
  );
  console.log("PASS: focusing Plugin source reveals the whole field frame above the keyboard");
} finally {
  evaluate(`(${reactNative}).Keyboard.dismiss()`);
  evaluate("delete globalThis.__appearanceKeyboardMeasurement");
}
