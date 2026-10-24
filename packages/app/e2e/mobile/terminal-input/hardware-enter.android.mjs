// Open the Android app from this checkout with agent-device and focus a shell terminal.
// node packages/app/e2e/mobile/terminal-input/hardware-enter.android.mjs <serial> <daemon-home> <terminal-id>
// Requires a local daemon, Node.js in the terminal, and the native terminal input focused.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [, , serial, home, terminalId] = process.argv;
assert(serial && home && terminalId, "Pass adb serial, daemon home, terminal ID");
const cli = fileURLToPath(new URL("../../../../cli/dist/index.js", import.meta.url));
function terminal(...args) {
  return execFileSync(process.execPath, [cli, "--home", home, "terminal", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}
function key(code) {
  execFileSync("adb", ["-s", serial, "shell", "input", "keyevent", code], { timeout: 10_000 });
}
function capture() {
  return JSON.parse(terminal("capture", terminalId, "--json")).lines.map((line) => line.trim());
}
async function waitForLine(line) {
  const deadline = Date.now() + 10_000;
  do {
    if (capture().includes(line)) return;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(`Terminal did not produce ${line}`);
}

// Inspect bytes at the PTY rather than counting prompts, which depend on the shell theme.
// Keep reading after Enter to catch its key-up event and to check the following character.
const reader = [
  "process.stdin.setRawMode(true)",
  "let hex = ''",
  "console.log('REA' + 'DY')",
  "process.stdin.on('data', data => {",
  "if (data.includes(3)) { process.stdin.setRawMode(false); process.exit(0); }",
  "hex += data.toString('hex'); console.log('HE' + 'X:' + hex);",
  "})",
].join(";");
const quotedReader = "'" + reader.replaceAll("'", "'\\''") + "'";
const command = `node -e ${quotedReader}`;
const failures = [];
for (const enter of ["KEYCODE_ENTER", "KEYCODE_NUMPAD_ENTER"]) {
  terminal("send-keys", terminalId, "--literal", command);
  terminal("send-keys", terminalId, "Enter");
  try {
    await waitForLine("READY");
    key(enter);
    await waitForLine("HEX:0d");
    // The second event is native key-up, so allow it to arrive before the assertion.
    await delay(500);
    assert(!capture().includes("HEX:0d0d"), `${enter} submitted twice`);
    key("KEYCODE_X");
    await waitForLine("HEX:0d78");
    console.log(`PASS: ${enter} sends one carriage return and preserves the next character`);
  } catch (error) {
    failures.push(error);
    console.error(error.message);
    console.error(
      "Observed:",
      capture().filter((line) => line.startsWith("HEX:")),
    );
  } finally {
    terminal("send-keys", terminalId, "C-c");
    await delay(300);
    terminal("send-keys", terminalId, "--literal", "clear");
    terminal("send-keys", terminalId, "Enter");
    await delay(300);
  }
}
assert.equal(failures.length, 0, "Hardware Enter regression");
