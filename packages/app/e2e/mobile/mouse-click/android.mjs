import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";

// A primary mouse click on a sidebar workspace row selects it (#3996).
// Run with the app on a wide Android layout, sidebar open, against a real daemon
// with at least two workspaces. The app must already run the checkout being verified.
// The click comes from a virtual USB mouse, so Android sends the same DOWN,
// BUTTON_PRESS, BUTTON_RELEASE, UP sequence as a physical touchpad click.
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const CLICK_HOLD_MS = 110;

function adb(...args) {
  return execFileSync("adb", ["-s", serial, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function workspaceRows() {
  adb("shell", "uiautomator", "dump", "/sdcard/paseo-mouse-click.xml");
  const xml = adb("shell", "cat", "/sdcard/paseo-mouse-click.xml");
  return [...xml.matchAll(/<node [^>]*resource-id="sidebar-workspace-row-[^"]*"[^>]*>/g)].map(
    ([node]) => {
      const [, left, top, right, bottom] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      return {
        id: node.match(/resource-id="([^"]*)"/)[1],
        selected: node.includes('selected="true"'),
        // The title line, clear of the PR and check badges on the second line.
        title: { x: +left + (right - left) / 4, y: +top + (bottom - top) / 3 },
      };
    },
  );
}

function cursorPosition() {
  const events = [
    ...adb("shell", "dumpsys", "input").matchAll(
      /source=MOUSE.*xCursorPosition=([\d.]+), yCursorPosition=([\d.]+).*age=(\d+)ms/g,
    ),
  ];
  assert.ok(events.length > 0, "Android reported no mouse events");
  const [, x, y] = events.reduce((latest, event) => (+event[3] < +latest[3] ? event : latest));
  return { x: +x, y: +y };
}

const MOUSE_NAME = "Paseo E2E Mouse";

async function openVirtualMouse() {
  const uinput = spawn("adb", ["-s", serial, "shell", "uinput", "-"], {
    stdio: ["pipe", "ignore", "inherit"],
  });
  // A mouse that never registered must fail as setup, not as a missed click.
  let failure = null;
  uinput.on("exit", (code, signal) => {
    failure ??= `uinput exited (code ${code}, signal ${signal})`;
  });
  uinput.on("error", (error) => {
    failure ??= `uinput failed to start: ${error.message}`;
  });
  uinput.stdin.on("error", (error) => {
    failure ??= `uinput stdin closed: ${error.message}`;
  });
  const send = (command) => {
    if (failure) throw new Error(failure);
    uinput.stdin.write(`${JSON.stringify({ id: 1, ...command })}\n`);
  };
  const inject = (...events) =>
    send({ command: "inject", events: [...events, "EV_SYN", "SYN_REPORT", 0] });
  send({
    command: "register",
    name: MOUSE_NAME,
    vid: 0x18d1,
    pid: 0x0001,
    bus: "usb",
    configuration: [
      { type: "UI_SET_EVBIT", data: ["EV_KEY", "EV_REL"] },
      { type: "UI_SET_KEYBIT", data: ["BTN_LEFT", "BTN_RIGHT", "BTN_MIDDLE"] },
      { type: "UI_SET_RELBIT", data: ["REL_X", "REL_Y"] },
    ],
  });
  const deadline = Date.now() + 5_000;
  while (!adb("shell", "dumpsys", "input").includes(MOUSE_NAME)) {
    if (failure) throw new Error(failure);
    if (Date.now() > deadline) throw new Error(`Android did not add ${MOUSE_NAME}`);
    await setTimeout(250);
  }
  return {
    // Pointer speed and acceleration scale relative motion, so steer by the
    // cursor position Android reports until it lands on the target.
    async moveTo(target) {
      inject("EV_REL", "REL_X", 1, "EV_REL", "REL_Y", 1);
      await setTimeout(150);
      for (let step = 0; step < 20; step += 1) {
        const cursor = cursorPosition();
        const dx = target.x - cursor.x;
        const dy = target.y - cursor.y;
        if (Math.abs(dx) <= 4 && Math.abs(dy) <= 4) return;
        const clamp = (delta) => Math.max(-60, Math.min(60, Math.round(delta / 3)));
        inject("EV_REL", "REL_X", clamp(dx), "EV_REL", "REL_Y", clamp(dy));
        await setTimeout(150);
      }
      throw new Error(`Cursor did not reach ${JSON.stringify(target)}`);
    },
    async click() {
      inject("EV_KEY", "BTN_LEFT", 1);
      await setTimeout(CLICK_HOLD_MS);
      inject("EV_KEY", "BTN_LEFT", 0);
    },
    close() {
      uinput.stdin.end();
      uinput.kill();
    },
  };
}

async function waitForSelected(id) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (workspaceRows().find((row) => row.id === id)?.selected) return true;
    await setTimeout(250);
  }
  return false;
}

const target = workspaceRows().find((row) => !row.selected);
assert.ok(target, "Open the sidebar with at least one unselected workspace row first");

const mouse = await openVirtualMouse();
try {
  await mouse.moveTo(target.title);
  await mouse.click();
  assert.ok(await waitForSelected(target.id), `Primary mouse click did not select ${target.id}`);
  console.log(`PASS: primary mouse click selected ${target.id}`);
} finally {
  mouse.close();
}
