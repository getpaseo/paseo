import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalInputModeState } from "@getpaseo/protocol/terminal-input-mode";
import {
  encodeTerminalOutput,
  TerminalEmulatorRuntime,
  type TerminalFindResults,
} from "./terminal-emulator-runtime";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddon {
    activate(): void {}
    dispose(): void {}
    onContextLoss(): void {}
  },
}));

interface TerminalSize {
  rows: number;
  cols: number;
  shouldClaim: boolean;
  forceClaim?: boolean;
}

interface TerminalKeyRecord {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

type BrowserTerminal = TerminalSize & {
  input: (data: string, wasUserInput?: boolean) => void;
  refresh: (start: number, end: number) => void;
  reset: () => void;
  buffer: { active: { viewportY: number } };
  getSelectionPosition: () => { start: { x: number; y: number } } | undefined;
  select: (column: number, row: number, length: number) => void;
};

interface MountedTerminal {
  host: HTMLDivElement;
  root: HTMLDivElement;
  runtime: TerminalEmulatorRuntime;
  inputs: string[];
  sizes: TerminalSize[];
  terminalKeys: TerminalKeyRecord[];
  inputModeChanges: TerminalInputModeState[];
  findResults: TerminalFindResults[];
  findBufferChanges: number;
}

const mountedTerminals: MountedTerminal[] = [];

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

function terminalOutput(text: string): Uint8Array {
  return encodeTerminalOutput(text);
}

async function waitFor(input: { predicate: () => boolean; timeoutMs?: number }): Promise<void> {
  const startedAt = performance.now();
  const timeoutMs = input.timeoutMs ?? 2_000;

  while (!input.predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for terminal browser condition");
    }
    await nextFrame();
  }
}

function settleMountRefits(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2_600));
}

function createTerminalHost(input: {
  width: number;
  height: number;
  scrollback?: number;
}): MountedTerminal {
  const root = document.createElement("div");
  root.style.width = `${input.width}px`;
  root.style.height = `${input.height}px`;
  root.style.position = "fixed";
  root.style.left = "0";
  root.style.top = "0";
  root.style.overflow = "hidden";

  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  root.appendChild(host);
  document.body.appendChild(root);

  const sizes: TerminalSize[] = [];
  const inputs: string[] = [];
  const terminalKeys: TerminalKeyRecord[] = [];
  const inputModeChanges: TerminalInputModeState[] = [];
  const findResults: TerminalFindResults[] = [];
  const mounted: MountedTerminal = {
    host,
    root,
    runtime: new TerminalEmulatorRuntime(),
    inputs,
    sizes,
    terminalKeys,
    inputModeChanges,
    findResults,
    findBufferChanges: 0,
  };
  const runtime = mounted.runtime;
  runtime.setCallbacks({
    callbacks: {
      onInput: (data) => {
        inputs.push(data);
      },
      onResize: (size) => {
        sizes.push(size);
      },
      onTerminalKey: (key) => {
        terminalKeys.push(key);
      },
      onInputModeChange: (state) => {
        inputModeChanges.push(state);
      },
      onFindResultsChange: (results) => {
        findResults.push(results);
      },
      onFindBufferChange: () => {
        mounted.findBufferChanges += 1;
      },
    },
  });
  runtime.mount({
    root,
    host,
    initialSnapshot: null,
    scrollback: input.scrollback ?? 10_000,
    theme: {
      background: "#0b0b0b",
      foreground: "#e6e6e6",
      cursor: "#e6e6e6",
    },
    findColors: { match: "#7a5c1f", activeMatch: "#8a4014" },
  });

  mountedTerminals.push(mounted);
  return mounted;
}

function writeAndSettle(mounted: MountedTerminal, text: string): Promise<void> {
  return new Promise((resolve) => {
    mounted.runtime.write({ data: terminalOutput(text), onCommitted: () => resolve() });
  });
}

function latestSize(sizes: TerminalSize[]): TerminalSize {
  const size = sizes.at(-1);
  if (!size) {
    throw new Error("Terminal did not report a size");
  }
  return size;
}

function expectNoForcedSameSizeClaim(input: {
  sizes: TerminalSize[];
  startIndex: number;
  baseline: TerminalSize;
}): void {
  const forcedSameSizeClaims = input.sizes
    .slice(input.startIndex)
    .filter(
      (size) =>
        size.rows === input.baseline.rows &&
        size.cols === input.baseline.cols &&
        size.shouldClaim &&
        size.forceClaim,
    );
  expect(forcedSameSizeClaims).toEqual([]);
}

function getBrowserTerminal(): BrowserTerminal {
  const terminal = window.__paseoTerminal as BrowserTerminal | undefined;
  if (!terminal) {
    throw new Error("Expected xterm to be exposed for browser test inspection");
  }
  return terminal;
}

function dispatchTerminalKey(input: {
  host: HTMLElement;
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): boolean {
  const textarea = input.host.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) {
    throw new Error("Expected xterm textarea to be mounted");
  }
  textarea.focus();
  return textarea.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: input.key,
      shiftKey: input.shiftKey ?? false,
      ctrlKey: input.ctrlKey ?? false,
      altKey: input.altKey ?? false,
      metaKey: input.metaKey ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

afterEach(() => {
  for (const mounted of mountedTerminals.splice(0)) {
    mounted.runtime.unmount();
    mounted.root.remove();
  }
});

describe("terminal emulator runtime in a real browser", () => {
  it("passes configured scrollback to xterm", async () => {
    await page.viewport(900, 600);
    createTerminalHost({ width: 720, height: 360, scrollback: 42_000 });

    await waitFor({
      predicate: () => window.__paseoTerminal !== undefined,
    });

    expect(window.__paseoTerminal?.options.scrollback).toBe(42_000);
  });

  it("updates scrollback on the mounted xterm", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360, scrollback: 10_000 });

    await waitFor({
      predicate: () => window.__paseoTerminal !== undefined,
    });
    const terminal = window.__paseoTerminal;

    mounted.runtime.setScrollback({ lines: 42_000 });

    expect(window.__paseoTerminal).toBe(terminal);
    expect(window.__paseoTerminal?.options.scrollback).toBe(42_000);
  });

  it("does not claim PTY ownership from passive mount refits", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();

    expect(mounted.sizes.length).toBeGreaterThan(1);
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);

    const settledSize = latestSize(mounted.sizes);
    mounted.runtime.resize({ forceClaim: true, shouldClaim: true });

    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([
      { ...settledSize, shouldClaim: true, forceClaim: true },
    ]);
  });

  it("reports a larger PTY size when the terminal container grows", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    const initialSize = latestSize(mounted.sizes);

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    await nextFrame();
    mounted.runtime.resize({ forceRefresh: true, shouldClaim: true });

    await waitFor({
      predicate: () => {
        const size = latestSize(mounted.sizes);
        return size.cols > initialSize.cols && size.rows > initialSize.rows;
      },
    });

    const grownSize = latestSize(mounted.sizes);
    expect(grownSize.cols).toBeGreaterThan(initialSize.cols);
    expect(grownSize.rows).toBeGreaterThan(initialSize.rows);
    expect(grownSize.shouldClaim).toBe(true);
  });

  it("keeps passive container measurements local after another client can claim", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    const initialSize = latestSize(mounted.sizes);
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";

    await waitFor({
      predicate: () =>
        mounted.sizes.some((size) => size.cols > initialSize.cols && size.rows > initialSize.rows),
    });

    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("keeps visual viewport keyboard refits passive", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    expect(window.visualViewport).not.toBeNull();
    window.visualViewport?.dispatchEvent(new Event("resize"));

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("keeps browser window refits passive", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    window.dispatchEvent(new Event("resize"));

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("does not force-claim a same-size resize while forwarding ordinary terminal input", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    const sizeCount = mounted.sizes.length;
    const sizeBeforeInput = latestSize(mounted.sizes);
    const terminal = getBrowserTerminal();

    terminal.input("a", true);

    await waitFor({ predicate: () => mounted.inputs.length > 0 });

    expect(mounted.inputs.at(-1)).toBe("a");
    expectNoForcedSameSizeClaim({
      sizes: mounted.sizes,
      startIndex: sizeCount,
      baseline: sizeBeforeInput,
    });
  });

  it("pastes through xterm's input producer", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    mounted.runtime.paste("legacy renderer paste");

    await waitFor({ predicate: () => mounted.inputs.length > 0 });
    expect(mounted.inputs).toEqual(["legacy renderer paste"]);
  });

  it("refreshes visible rows on a forced same-size resize", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    const terminal = getBrowserTerminal();
    const refreshCalls: Array<[number, number]> = [];
    const originalRefresh = terminal.refresh.bind(terminal);
    terminal.refresh = (start, end) => {
      refreshCalls.push([start, end]);
      originalRefresh(start, end);
    };

    mounted.runtime.resize({ forceRefresh: true, shouldClaim: false });

    await waitFor({ predicate: () => refreshCalls.length > 0 });
    expect(refreshCalls.at(-1)).toEqual([0, terminal.rows - 1]);
  });

  it("intercepts Shift+Enter only after enhanced terminal input mode is active", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([]);

    mounted.runtime.write({ data: terminalOutput("\x1b[>7u") });
    await waitFor({
      predicate: () =>
        mounted.inputModeChanges.some(
          (state) => state.kittyKeyboardFlags === 7 && !state.win32InputMode,
        ),
    });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);

    mounted.terminalKeys.length = 0;
    mounted.runtime.write({ data: terminalOutput("\x1b[=0;0u\x1b[?9001h") });
    await waitFor({
      predicate: () =>
        mounted.inputModeChanges.some(
          (state) => state.kittyKeyboardFlags === 0 && state.win32InputMode,
        ),
    });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);

    const sizeCount = mounted.sizes.length;
    const sizeBeforeKey = latestSize(mounted.sizes);
    mounted.terminalKeys.length = 0;

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);
    expectNoForcedSameSizeClaim({
      sizes: mounted.sizes,
      startIndex: sizeCount,
      baseline: sizeBeforeKey,
    });
  });

  it.each([
    { name: "DA1", bytes: "\x1b[c" },
    { name: "DA1-zero", bytes: "\x1b[0c" },
    { name: "DA2", bytes: "\x1b[>c" },
    { name: "DA3", bytes: "\x1b[=c" },
    { name: "DSR-5", bytes: "\x1b[5n" },
    { name: "DSR-6", bytes: "\x1b[6n" },
    { name: "DSR-?6", bytes: "\x1b[?6n" },
    { name: "DECRQM", bytes: "\x1b[1$p" },
    { name: "DECRQM-?", bytes: "\x1b[?1$p" },
    { name: "OSC-10-foreground-color", bytes: "\x1b]10;?\x07" },
    { name: "OSC-11-background-color", bytes: "\x1b]11;?\x07" },
    { name: "OSC-12-cursor-color", bytes: "\x1b]12;?\x07" },
  ])("does not emit a PTY input reply for $name", async ({ bytes }) => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    mounted.runtime.write({ data: terminalOutput(bytes) });
    await nextFrame();
    await nextFrame();

    expect(mounted.inputs).toEqual([]);
  });

  it("replays snapshots without synchronously resetting the visible terminal", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    const terminal = getBrowserTerminal();
    const originalReset = terminal.reset.bind(terminal);
    const reset = vi.fn(originalReset);
    terminal.reset = reset;

    mounted.runtime.renderSnapshot({
      state: {
        rows: terminal.rows,
        cols: terminal.cols,
        scrollback: [],
        grid: [
          [
            { char: "p" },
            { char: "r" },
            { char: "o" },
            { char: "m" },
            { char: "p" },
            { char: "t" },
          ],
        ],
        cursor: {
          row: 0,
          col: 6,
        },
      },
    });
    await nextFrame();

    expect(reset).not.toHaveBeenCalled();
  });

  it("counts every match and reports the active one through the search addon", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });
    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await writeAndSettle(mounted, "alpha beta\r\nbeta gamma\r\ndelta beta\r\n");

    mounted.runtime.findNext({ term: "beta" });

    await waitFor({ predicate: () => mounted.findResults.length > 0 });
    expect(mounted.findResults.at(-1)).toEqual({
      resultIndex: 0,
      resultCount: 3,
      countIsCapped: false,
    });

    mounted.runtime.findNext({ term: "beta" });
    await waitFor({ predicate: () => mounted.findResults.at(-1)?.resultIndex === 1 });

    mounted.runtime.findPrevious({ term: "beta" });
    await waitFor({ predicate: () => mounted.findResults.at(-1)?.resultIndex === 0 });
  });

  it("starts a new term at the visible screen instead of the top of the scrollback", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });
    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    const terminal = getBrowserTerminal();
    const filler = "filler\r\n".repeat(terminal.rows * 3);
    await writeAndSettle(mounted, `needle\r\n${filler}needle\r\n`);

    mounted.runtime.findNext({ term: "needle" });

    const selection = terminal.getSelectionPosition();
    expect(selection).toBeDefined();
    expect(selection?.start.y).toBeGreaterThanOrEqual(terminal.buffer.active.viewportY);
  });

  // The addon tracks only the matches it highlighted, so a match found past its limit
  // reports -1 forever: the bar has to say "1000+ matches", not "1 of 1000".
  it("reports a capped count once the buffer holds more matches than the highlight limit", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });
    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await writeAndSettle(mounted, "needle\r\n".repeat(1_200));

    mounted.runtime.findNext({ term: "needle" });

    await waitFor({ predicate: () => mounted.findResults.length > 0 });
    expect(mounted.findResults.at(-1)).toEqual({
      resultIndex: -1,
      resultCount: 1_000,
      countIsCapped: true,
    });
  });

  it("repaints a running search in a new theme without stepping to the next match", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });
    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await writeAndSettle(mounted, "alpha beta\r\nbeta gamma\r\ndelta beta\r\n");

    mounted.runtime.findNext({ term: "beta" });
    await waitFor({ predicate: () => mounted.findResults.at(-1)?.resultIndex === 0 });

    // Decorations keep the colours they were created with, and the addon caches the
    // options it last searched with, so nothing else repaints them.
    mounted.runtime.setTheme({
      theme: { background: "#101010", foreground: "#fafafa", cursor: "#fafafa" },
      findColors: { match: "#1f5c7a", activeMatch: "#14408a" },
    });

    await nextFrame();
    expect(mounted.findResults.at(-1)?.resultIndex).toBe(0);
    expect(mounted.runtime.getSelectionText()).toBe("beta");
  });

  it("drops the decorations and the selection a search made, and nothing else", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });
    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await writeAndSettle(mounted, "alpha beta\r\n");

    getBrowserTerminal().select(0, 0, 5);
    mounted.runtime.clearFind();
    expect(mounted.runtime.getSelectionText()).toBe("alpha");

    mounted.runtime.findNext({ term: "beta" });
    expect(mounted.runtime.getSelectionText()).toBe("beta");

    mounted.runtime.clearFind();
    expect(mounted.runtime.getSelectionText()).toBe("");
  });

  it("drops the find when the app switches to the alternate screen", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });
    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await writeAndSettle(mounted, "alpha beta\r\n");

    mounted.runtime.findNext({ term: "beta" });
    expect(mounted.runtime.getSelectionText()).toBe("beta");

    // Decorations are markers on the buffer that was active when the search ran, so the
    // alternate screen has to restart the search rather than inherit them.
    await writeAndSettle(mounted, "\u001b[?1049h");

    await waitFor({ predicate: () => mounted.findBufferChanges > 0 });
    expect(mounted.runtime.getSelectionText()).toBe("");
  });
});
