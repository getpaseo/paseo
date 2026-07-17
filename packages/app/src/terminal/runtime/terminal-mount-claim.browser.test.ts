import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalEmulatorRuntime } from "./terminal-emulator-runtime";

/**
 * Pins the mechanism behind "terminal stuck at 80x24".
 *
 * The daemon spawns a PTY at 80x24 and only resizes it when the client sends a resize frame.
 * `handleTerminalResize` in terminal-pane only forwards a frame when the emitted fit carries
 * `shouldClaim: true`.
 *
 * These tests show that a freshly mounted terminal NEVER emits such a fit. Every mount-time
 * refit (the mount fit, the retry ladder, fonts.ready, the WebGL swap, visibility restore) is
 * emitted with `shouldClaim: false`. The ResizeObserver's first delivery IS `shouldClaim: true`,
 * but it is emitted without `force`, so the runtime's own dedupe drops it: the size has not
 * changed since the mount fit.
 *
 * So after a fresh mount, in a pane whose size never changes, the client sends the daemon
 * NOTHING. The PTY keeps whatever size it was created with. The terminal's size then depends
 * entirely on either the size carried at subscribe, or an explicit forced reflow
 * (`requestTerminalReflow` -> `runtime.resize({force, shouldClaim})`) -- which is exactly the
 * path terminal-pane's focus effects can permanently latch off.
 */

interface EmittedSize {
  rows: number;
  cols: number;
  shouldClaim: boolean;
}

interface MountedTerminal {
  root: HTMLDivElement;
  runtime: TerminalEmulatorRuntime;
  sizes: EmittedSize[];
}

const mounted: MountedTerminal[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.runtime.unmount();
    entry.root.remove();
  }
});

function mountTerminal(input: { width: number; height: number }): MountedTerminal {
  const root = document.createElement("div");
  root.style.cssText = `width:${input.width}px;height:${input.height}px;position:fixed;left:0;top:0;overflow:hidden`;
  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%";
  root.appendChild(host);
  document.body.appendChild(root);

  const sizes: EmittedSize[] = [];
  const runtime = new TerminalEmulatorRuntime();
  runtime.setCallbacks({
    callbacks: {
      onResize: (size) => {
        sizes.push(size as EmittedSize);
      },
    },
  });
  runtime.mount({
    root,
    host,
    initialSnapshot: null,
    scrollback: 1_000,
    theme: { background: "#0b0b0b", foreground: "#e6e6e6", cursor: "#e6e6e6" },
  });

  const entry = { root, runtime, sizes };
  mounted.push(entry);
  return entry;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
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

/**
 * Outlast the runtime's whole refit ladder (0/16/48/120/250/500/1000/2000ms) plus fonts and the
 * WebGL swap, so nothing is still in flight when we assert. Unlike every other wait in this file
 * this one cannot be a predicate: the point is to prove that no claim EVER arrives, and there is
 * no event that says "the mount is done emitting".
 */
function settleMountRefits(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2_600));
}

describe("a freshly mounted terminal never claims its size", () => {
  it("emits many fits on mount, and not one of them claims the PTY size", async () => {
    await page.viewport(1400, 900);
    const terminal = mountTerminal({ width: 900, height: 600 });

    await settleMountRefits();

    // It really did refit repeatedly while mounting...
    expect(terminal.sizes.length).toBeGreaterThan(1);
    // ...and it measured a real viewport, not the daemon's default.
    expect(terminal.sizes.at(-1)?.cols).not.toBe(80);

    // ...but every single one of those fits declined to own the PTY size, so terminal-pane
    // forwards NOTHING to the daemon. This is why a terminal can sit at 80x24 while its xterm
    // renders perfectly at the real size.
    const claims = terminal.sizes.filter((size) => size.shouldClaim);
    expect(claims).toEqual([]);
  });

  it("only an explicit forced reflow claims — the path the focus latch can kill", async () => {
    await page.viewport(1400, 900);
    const terminal = mountTerminal({ width: 900, height: 600 });
    await settleMountRefits();
    expect(terminal.sizes.filter((size) => size.shouldClaim)).toEqual([]);
    const settledSize = terminal.sizes.at(-1);

    // This is what requestTerminalReflow does. It is the ONLY thing that makes a
    // stable-sized, freshly mounted terminal tell the daemon how big it is.
    terminal.runtime.resize({ force: true, shouldClaim: true });

    // It claims the size the terminal actually settled at, so the PTY ends up matching what the
    // user sees rendered.
    expect(terminal.sizes.filter((size) => size.shouldClaim)).toEqual([
      { rows: settledSize?.rows, cols: settledSize?.cols, shouldClaim: true },
    ]);
  });

  it("a genuine size change does claim — which is why resizing the window unsticks it", async () => {
    await page.viewport(1400, 900);
    const terminal = mountTerminal({ width: 900, height: 600 });
    await settleMountRefits();
    expect(terminal.sizes.filter((size) => size.shouldClaim)).toEqual([]);

    // The ResizeObserver fit IS shouldClaim:true; it is only suppressed while the size is
    // unchanged. Change the box and it gets through -- the user-visible "resize the window and
    // it fixes itself" behaviour.
    terminal.root.style.width = "1300px";

    await waitFor({ predicate: () => terminal.sizes.some((size) => size.shouldClaim) });
    const claims = terminal.sizes.filter((size) => size.shouldClaim);
    // The claim carries the NEW width, not the size it mounted at.
    expect(claims.at(-1)?.cols).toBeGreaterThan(terminal.sizes[0]?.cols ?? 0);
  });
});
