import "@xterm/xterm/css/xterm.css";
import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { encodeTerminalOutput, TerminalEmulatorRuntime } from "./terminal-emulator-runtime";

interface TerminalView {
  root: HTMLDivElement;
  host: HTMLDivElement;
  runtime: TerminalEmulatorRuntime;
  terminal: Terminal;
}

interface RowImage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

const views: TerminalView[] = [];
const header = "HEADER_0123456789 한글 日本語";

function mountTerminal(left: number): TerminalView {
  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "fixed",
    left: `${left}px`,
    top: "0",
    width: "440px",
    height: "360px",
    overflow: "hidden",
  });
  const host = document.createElement("div");
  Object.assign(host.style, { width: "100%", height: "100%" });
  root.appendChild(host);
  document.body.appendChild(root);
  const runtime = new TerminalEmulatorRuntime();
  runtime.mount({
    root,
    host,
    initialSnapshot: null,
    scrollback: 1000,
    fontFamily: "monospace",
    fontSize: 16,
    theme: { background: "#101010", foreground: "#eeeeee", cursor: "#eeeeee" },
  });
  const terminal = window.__paseoTerminal;
  if (!terminal) throw new Error("Terminal did not mount");
  const view = { root, host, runtime, terminal };
  views.push(view);
  return view;
}

function write(view: TerminalView, text: string): Promise<void> {
  return new Promise((resolve) => {
    view.runtime.write({ data: encodeTerminalOutput(text), onCommitted: resolve });
  });
}

function webglCanvas(view: TerminalView): HTMLCanvasElement {
  for (const canvas of view.host.querySelectorAll(".xterm-screen canvas")) {
    if (canvas instanceof HTMLCanvasElement && canvas.getContext("webgl2")) return canvas;
  }
  throw new Error("Real WebGL is required; DOM fallback cannot test glyph corruption");
}

async function mountPair() {
  await page.viewport(1000, 600);
  const active = mountTerminal(0);
  const sibling = mountTerminal(460);
  await document.fonts.ready;
  await expect
    .poll(() => active.host.querySelectorAll(".xterm-screen canvas").length)
    .toBeGreaterThan(0);
  await expect
    .poll(() => sibling.host.querySelectorAll(".xterm-screen canvas").length)
    .toBeGreaterThan(0);
  webglCanvas(active);
  webglCanvas(sibling);
  await write(active, "\x1b[?25l");
  await write(sibling, "\x1b[?25l");
  return { active, sibling };
}

function captureHeader(input: { view: TerminalView; output?: string }): Promise<RowImage> {
  const { view, output } = input;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      rendered.dispose();
      reject(new Error("Terminal did not render within 2 seconds"));
    }, 2000);
    const rendered = view.terminal.onRender(() => {
      rendered.dispose();
      clearTimeout(timeout);
      try {
        // Copy during onRender, before WebGL discards its default drawing buffer.
        const source = webglCanvas(view);
        const canvas = document.createElement("canvas");
        canvas.width = source.width;
        canvas.height = Math.round(source.height / view.terminal.rows);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D pixel capture is unavailable");
        context.drawImage(source, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        resolve({ width: canvas.width, height: canvas.height, pixels });
      } catch (error) {
        reject(error);
      }
    });
    if (output === undefined) view.terminal.refresh(0, view.terminal.rows - 1);
    else view.runtime.write({ data: encodeTerminalOutput(output) });
  });
}

function expectSamePixels(input: { expected: RowImage; actual: RowImage; label: string }): void {
  const { expected, actual, label } = input;
  expect(actual.width, label).toBe(expected.width);
  expect(actual.height, label).toBe(expected.height);
  let changed = 0;
  for (let index = 0; index < expected.pixels.length; index += 1) {
    if (expected.pixels[index] !== actual.pixels[index]) changed += 1;
  }
  expect(changed, label).toBe(0);
}

function coloredOutput(input: { cells: number; offset: number }): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let output = "";
  for (let index = 0; index < input.cells; index += 1) {
    const value = index + input.offset;
    const foreground = `${value % 256};${(value >> 8) % 256};${(value * 13) % 256}`;
    const background = (value * 7) % 256;
    output += `\x1b[38;2;${foreground}m\x1b[48;5;${background}m${alphabet[value % alphabet.length]}`;
  }
  return `${output}\x1b[0m`;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.runtime.unmount();
    view.root.remove();
  }
});

it("preserves another terminal's glyph pixels when a shared atlas is cleared", async () => {
  const { active, sibling } = await mountPair();
  await write(sibling, header);
  const before = await captureHeader({ view: sibling });
  const visibleChannels = before.pixels.filter(
    (channel, index) => index % 4 !== 3 && channel > 100,
  );
  expect(visibleChannels.length).toBeGreaterThan(100);

  active.terminal.clearTextureAtlas();
  await captureHeader({ view: active, output: coloredOutput({ cells: 2000, offset: 0 }) });
  const after = await captureHeader({
    view: sibling,
    output: `\x1b[${sibling.terminal.rows};1Hx`,
  });
  expect(sibling.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(header);
  expectSamePixels({ expected: before, actual: after, label: "sibling after atlas clear" });
});

it("preserves both headers while ordinary output grows the shared glyph atlas", async () => {
  const { active, sibling } = await mountPair();
  const cells = active.terminal.cols * (active.terminal.rows - 2);
  // Startup glyphs can stay on an unmerged page and hide this bug. Allocate the
  // reference after some output, as a real long-running TUI does.
  for (let batch = 0; batch < 16; batch += 1) {
    await captureHeader({
      view: active,
      output: `\x1b[H${coloredOutput({ cells, offset: batch * cells })}`,
    });
  }
  const lateHeader = `\x1b[H\x1b[0m\x1b[2K\x1b[38;2;253;251;247m${header}\x1b[0m`;
  await write(active, lateHeader);
  await write(sibling, lateHeader);
  const activeBefore = await captureHeader({ view: active });
  const siblingBefore = await captureHeader({ view: sibling });

  for (let batch = 0; batch < 256; batch += 1) {
    const activeFrame = await captureHeader({
      view: active,
      output: `\x1b[2;1H${coloredOutput({ cells, offset: (batch + 16) * cells })}`,
    });
    const siblingFrame = await captureHeader({
      view: sibling,
      output: `\x1b[${sibling.terminal.rows};1H${batch % 10}`,
    });
    expect(active.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(header);
    expect(sibling.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(header);
    expectSamePixels({
      expected: activeBefore,
      actual: activeFrame,
      label: `active frame ${batch}`,
    });
    expectSamePixels({
      expected: siblingBefore,
      actual: siblingFrame,
      label: `sibling frame ${batch}`,
    });
  }
}, 30000);
