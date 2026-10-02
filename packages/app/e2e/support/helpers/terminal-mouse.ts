import { expect, type Page } from "@playwright/test";
import type { TerminalE2EHarness, TerminalInstance } from "./terminal-dsl";
import { waitForTerminalContent } from "./terminal-perf";

/**
 * Drives a terminal whose foreground program enables SGR mouse tracking.
 *
 * The child enables mouse exactly once (on the first keypress) and never again,
 * so after a client re-attach the only thing that can re-enable mouse reporting
 * is the terminal's replay preamble. That makes `wheelReportsToApp` a direct
 * probe for whether a restore preserved mouse mode.
 */
const MOUSE_PROGRAM = [
  "process.stdin.setRawMode?.(true);",
  "process.stdin.resume();",
  'process.stdout.write("MOUSE_READY\\r\\n");',
  'process.stdin.on("data", function () {',
  '  process.stdout.write("\\u001b[?1000h\\u001b[?1002h\\u001b[?1003h\\u001b[?1006h");',
  '  process.stdout.write("MOUSE_ON\\r\\n");',
  "});",
  "setInterval(function () {}, 1000);",
].join("\n");

const ESC = String.fromCharCode(0x1b);

interface TerminalWindow {
  __paseoTerminal?: {
    element: HTMLElement;
    onData: (cb: (data: string) => void) => { dispose: () => void };
  };
}

function readMouseMode(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const terminal = (window as unknown as TerminalWindow).__paseoTerminal;
    return Boolean(terminal?.element.classList.contains("enable-mouse-events"));
  });
}

async function readWheelReport(page: Page): Promise<{ mouseMode: boolean; emitted: string }> {
  return page.evaluate(async () => {
    const terminal = (window as unknown as TerminalWindow).__paseoTerminal;
    if (!terminal) {
      return { mouseMode: false, emitted: "" };
    }
    const emitted: string[] = [];
    const subscription = terminal.onData((data) => emitted.push(data));
    terminal.element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -120, deltaMode: 0, bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    subscription.dispose();
    return {
      mouseMode: terminal.element.classList.contains("enable-mouse-events"),
      emitted: emitted.join(""),
    };
  });
}

/** SGR mouse report for wheel up/down: ESC [ < 64/65 ; col ; row M. */
function isSgrWheelReport(data: string): boolean {
  return data.includes(`${ESC}[<64;`) || data.includes(`${ESC}[<65;`);
}

export interface MouseTerminal {
  /** Enables SGR mouse from the running program and waits until the client reports it. */
  enableMouse(): Promise<void>;
  /** Whether a wheel event is reported to the program as an SGR mouse report. */
  wheelReportsToApp(): Promise<boolean>;
  /** Re-attaches the client, forcing a terminal restore. */
  reattach(): Promise<void>;
}

/**
 * Creates a mouse-enabled terminal, opens it, and hands the caller an intent-level
 * handle. Owns the terminal and cleans it up on exit.
 */
export async function withMouseTerminal<T>(
  page: Page,
  harness: TerminalE2EHarness,
  fn: (terminal: MouseTerminal) => Promise<T>,
): Promise<T> {
  const instance: TerminalInstance = await harness.createTerminal({
    name: "mouse",
    command: process.execPath,
    args: ["-e", MOUSE_PROGRAM],
  });

  const waitUntilReady = () =>
    waitForTerminalContent(page, (text) => text.includes("MOUSE_READY"), 20_000);

  try {
    await harness.openTerminal(page, { terminalId: instance.id });
    await waitUntilReady();

    return await fn({
      async enableMouse() {
        await harness.terminalSurface(page).pressSequentially("a", { delay: 0 });
        await waitForTerminalContent(page, (text) => text.includes("MOUSE_ON"), 10_000);
        await expect.poll(() => readMouseMode(page), { timeout: 10_000 }).toBe(true);
      },
      async wheelReportsToApp() {
        await expect.poll(() => readMouseMode(page), { timeout: 10_000 }).toBe(true);
        const report = await readWheelReport(page);
        return report.mouseMode && isSgrWheelReport(report.emitted);
      },
      async reattach() {
        await harness.openTerminal(page, { terminalId: instance.id });
        await waitUntilReady();
      },
    });
  } finally {
    await harness.killTerminal(instance.id);
  }
}
