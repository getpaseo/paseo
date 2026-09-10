import "@xterm/xterm/css/xterm.css";
import { afterEach, expect, test } from "vitest";
import {
  TerminalEmulatorRuntime,
  encodeTerminalOutput,
  type TerminalFindResult,
} from "./terminal-emulator-runtime";

let runtime: TerminalEmulatorRuntime;
let root: HTMLDivElement;
afterEach(() => {
  runtime?.unmount();
  root?.remove();
});
function mount() {
  root = document.createElement("div");
  Object.assign(root.style, { width: "480px", height: "200px" });
  const host = document.createElement("div");
  Object.assign(host.style, { width: "100%", height: "100%" });
  root.append(host);
  document.body.append(root);
  runtime = new TerminalEmulatorRuntime();
  const results: TerminalFindResult[] = [];
  runtime.setCallbacks({
    callbacks: {
      onFindResult: (result) => {
        results.push(result);
      },
    },
  });
  runtime.mount({
    root,
    host,
    initialSnapshot: null,
    scrollback: 1000,
    theme: { background: "#ffffff", foreground: "#111111" },
  });
  return results;
}
function write(text: string) {
  return new Promise<void>((resolve) =>
    runtime.write({ data: encodeTerminalOutput(text), onCommitted: resolve }),
  );
}

test("uses xterm's literal matching across wrapped cells and keeps selection when Find closes", async () => {
  const results = mount();
  // Initial font measurement schedules refits through 2 seconds. Settle them
  // before choosing an exact column boundary for the wrapped text fixture.
  await new Promise((resolve) => setTimeout(resolve, 2600));
  await write("first [a.b] 界\r\n" + "padding\r\n".repeat(30) + "last [A.B] 界");
  runtime.find.search("[a.b] 界");
  expect(results.at(-1)).toMatchObject({ resultCount: 2, resultIndex: 1, limited: false });
  runtime.find.search("[a.b] 界", "previous");
  expect(results.at(-1)).toMatchObject({ resultCount: 2, resultIndex: 0, placement: "top" });
  runtime.find.search("[a.b] 界", "previous");
  expect(results.at(-1)).toMatchObject({ resultCount: 2, resultIndex: 1 });
  const selection = window.__paseoTerminal!.getSelection();
  runtime.find.clear();
  expect(window.__paseoTerminal!.getSelection()).toBe(selection);
  expect(results.at(-1)).toMatchObject({ resultCount: 0, resultIndex: -1 });
  runtime.find.search("[aXb]");
  expect(results.at(-1)).toMatchObject({ resultCount: 0 });
  const cols = window.__paseoTerminal!.cols;
  await write("\r\n" + "x".repeat(cols - 2) + "wrapped-needle");
  runtime.find.search("wrapped-needle");
  await expect.poll(() => results.at(-1)).toMatchObject({ resultCount: 1, resultIndex: 0 });
});

test("reports the addon's highlight limit without disabling navigation beyond the counted matches", async () => {
  const results = mount();
  await write(("a ".repeat(25) + "\r\n").repeat(801));
  runtime.find.search("a");
  expect(results.at(-1)).toMatchObject({ resultCount: 20000, limited: true, resultIndex: -1 });
  expect(window.__paseoTerminal!.getSelection()).toBe("a");
  runtime.find.search("a", "next");
  expect(results.at(-1)).toMatchObject({ resultCount: 20000, limited: true, resultIndex: 0 });
});

test("keeps the inspected bottom viewport fixed when output arrives", async () => {
  mount();
  await write("padding\r\n".repeat(30) + "inspected needle");
  runtime.find.search("needle");
  const term = window.__paseoTerminal!;
  const inspected = term.buffer.active.viewportY;
  await write("\r\nnew output".repeat(30));
  await expect.poll(() => term.buffer.active.viewportY).toBe(inspected);
  expect(term.getSelection()).toBe("needle");
});

test("searches the active alternate buffer without moving the restored normal viewport", async () => {
  const results = mount();
  await write("normal needle\r\n" + "padding\r\n".repeat(30));
  const normalViewport = window.__paseoTerminal!.buffer.active.viewportY;
  await write("\x1b[?1049hAlt needle\r\nAlt NEEDLE");
  runtime.find.search("needle");
  expect(results.at(-1)).toMatchObject({ resultCount: 2, resultIndex: 1, limited: false });
  expect(window.__paseoTerminal!.getSelection()).toBe("NEEDLE");
  runtime.find.search("needle", "previous");
  expect(window.__paseoTerminal!.getSelection()).toBe("needle");
  await write("\x1b[?1049l");
  await expect.poll(() => window.__paseoTerminal!.buffer.active.viewportY).toBe(normalViewport);
  runtime.find.search("needle");
  await expect.poll(() => results.at(-1)).toMatchObject({ resultCount: 1, resultIndex: 0 });
});

test("keeps Find at the top unless its measured frame covers the active match", async () => {
  const results = mount();
  await new Promise((resolve) => setTimeout(resolve, 2600));
  runtime.find.setWidgetSize({ width: 356, height: 58 });
  const cols = window.__paseoTerminal!.cols;
  await write("left-needle\r\n" + " ".repeat(cols - 12) + "right-needle");
  runtime.find.search("left-needle");
  expect(results.at(-1)).toMatchObject({ resultCount: 1, placement: "top" });
  runtime.find.search("right-needle");
  expect(results.at(-1)).toMatchObject({ resultCount: 1, placement: "bottom" });
});

test("closing Find cancels pending refreshes without clearing old or new selections", async () => {
  mount();
  await write("first needle\r\n" + "padding\r\n".repeat(30) + "last needle");
  const term = window.__paseoTerminal!;
  for (const freshSelection of [false, true]) {
    runtime.find.search("needle");
    await write("\r\nnew output");
    // onWriteParsed schedules the addon's refresh after the write callback.
    await new Promise<void>((resolve) => {
      const subscription = term.onWriteParsed(() => {
        subscription.dispose();
        resolve();
      });
      runtime.write({ data: encodeTerminalOutput("\rprogress") });
    });
    runtime.find.clear();
    if (freshSelection) term.select(0, 0, 5);
    const selection = term.getSelection();
    expect(selection).toBe(freshSelection ? "first" : "needle");
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(term.getSelection()).toBe(selection);
  }
});

test("preserves inspection through multiple real parser turns of queued output", async () => {
  mount();
  await new Promise((resolve) => setTimeout(resolve, 2600));
  await write("padding\r\n".repeat(30) + "needle\r\nprogress");
  runtime.find.search("needle");
  const term = window.__paseoTerminal!;
  const inspected = term.buffer.active.viewportY;
  const samples: { viewport: number; base: number }[] = [];
  const subscription = term.onWriteParsed(() => {
    samples.push({ viewport: term.buffer.active.viewportY, base: term.buffer.active.baseY });
  });
  for (let i = 0; i < 150; i++) {
    runtime.write({ data: encodeTerminalOutput("\rprogress".repeat(1000)) });
  }
  await write("\r\nnew output".repeat(100));
  await new Promise((resolve) => setTimeout(resolve, 350));
  subscription.dispose();
  expect(samples.length).toBeGreaterThan(1);
  expect(samples[0].base).toBe(inspected);
  expect(samples.at(-1)!.base).toBeGreaterThan(inspected);
  expect(term.buffer.active.viewportY).toBe(inspected);
  expect(term.getSelection()).toBe("needle");
});
