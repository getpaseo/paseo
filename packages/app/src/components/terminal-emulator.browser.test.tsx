import { cleanup, render } from "@testing-library/react";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import TerminalEmulator from "./terminal-emulator";

vi.mock("expo/dom", () => ({ useDOMImperativeHandle: () => {} }));

const PADDING = 8;
const THEME = { background: "#0b0b0b", foreground: "#e6e6e6" };

function measure(container: HTMLElement) {
  const root = container.querySelector("[data-terminal-scrollbar-root]");
  const screen = root?.querySelector(".xterm-screen");
  const terminal = window.__paseoTerminal as { rows: number; cols: number } | undefined;
  if (!root || !screen || !terminal) {
    throw new Error("Terminal did not mount");
  }
  const outer = root.getBoundingClientRect();
  const grid = screen.getBoundingClientRect();
  return {
    rows: terminal.rows,
    left: grid.left - outer.left,
    top: grid.top - outer.top,
    right: outer.right - grid.right,
    bottom: outer.bottom - grid.bottom,
    rowHeight: grid.height / terminal.rows,
    outerHeight: outer.height,
  };
}

let pane: HTMLElement | null = null;

afterEach(() => {
  cleanup();
  pane?.remove();
  pane = null;
});

async function mountTerminal(height: number) {
  await page.viewport(800, 600);
  pane = document.createElement("div");
  pane.style.cssText = `width:560px;height:${height}px;position:fixed;left:0;top:0`;
  // The runtime sets its root's parent to 100%, so the size lives one level up.
  const container = pane.appendChild(document.createElement("div"));
  document.body.appendChild(pane);
  render(
    <TerminalEmulator
      ref={null}
      streamKey="padding"
      supportsTerminalInputModeReplay
      xtermTheme={THEME}
      scrollbackLines={1000}
      characterWidths="graphemes"
    />,
    { container },
  );
  await expect
    .poll(() => {
      const size = measure(container);
      return size.rows - Math.floor((height - 2 * PADDING) / size.rowHeight);
    })
    .toBe(0);
  const root = container.querySelector("[data-terminal-scrollbar-root]");
  const terminal = window.__paseoTerminal as Terminal | undefined;
  if (!root || !terminal) {
    throw new Error("Terminal did not mount");
  }
  return { container, root, terminal };
}

async function mountWithOutput() {
  const mounted = await mountTerminal(377);
  await new Promise<void>((resolve) => mounted.terminal.write("line\r\n".repeat(100), resolve));
  return mounted;
}

function mouse(type: string, clientX: number, clientY: number) {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    buttons: 1,
    clientX,
    clientY,
    detail: 1,
  });
}

it.each([360, 361, 366, 372, 377])(
  "keeps the grid inside the padding in a %ipx tall pane",
  async (height) => {
    const { container } = await mountTerminal(height);
    const size = measure(container);
    expect(size.outerHeight).toBe(height);
    expect(size.left).toBe(PADDING);
    expect(size.top).toBe(PADDING);
    expect(size.right).toBeGreaterThanOrEqual(PADDING);
    expect(size.bottom).toBeGreaterThanOrEqual(PADDING);
  },
);

it("scrolls when the wheel turns over the padding", async () => {
  const { root, terminal } = await mountWithOutput();
  const bottom = terminal.buffer.active.viewportY;
  const targets: (EventTarget | null)[] = [];
  root.addEventListener("wheel", (event) => {
    if (event.isTrusted) {
      targets.push(event.target);
    }
  });
  // A real wheel: Chrome gives synthetic ones a `wheelDeltaY` of the wrong sign, which xterm reads.
  const frame = window.frameElement?.getBoundingClientRect();
  const scale = frame ? frame.width / window.innerWidth : 1;
  // The viewport takes its scroll height on a later frame, so an early turn does nothing.
  await expect
    .poll(async () => {
      await cdp().send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: (frame?.left ?? 0) + 3 * scale,
        y: (frame?.top ?? 0) + 100 * scale,
        deltaX: 0,
        deltaY: -200,
      });
      return terminal.buffer.active.viewportY;
    })
    .toBeLessThan(bottom);
  expect(new Set(targets)).toEqual(new Set([root]));
});

it("selects text with a drag that starts in the padding", async () => {
  const { root, terminal } = await mountWithOutput();
  root.dispatchEvent(mouse("mousedown", 3, 50));
  document.dispatchEvent(mouse("mousemove", 200, 110));
  document.dispatchEvent(mouse("mouseup", 200, 110));
  await expect.poll(() => terminal.getSelection()).toContain("line");
});

it("keeps focus in the terminal after a click in the padding", async () => {
  const { root } = await mountWithOutput();
  await userEvent.click(page.elementLocator(root), { position: { x: 3, y: 100 } });
  expect(root.contains(document.activeElement)).toBe(true);
});
