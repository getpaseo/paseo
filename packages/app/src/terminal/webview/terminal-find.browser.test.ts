import type { Terminal } from "@xterm/xterm";
import { afterEach, expect, test } from "vitest";
import { terminalEmulatorWebViewHtml } from "./terminal-emulator-webview-html";

interface Message {
  type: string;
  streamKey?: string;
  result?: { resultCount: number; resultIndex: number };
  data?: string;
}
interface TerminalFrameWindow extends Window {
  __PASEO_TERMINAL_WEBVIEW_RECEIVE__(message: unknown): void;
  __paseoTerminal?: Terminal;
}
let frame: HTMLIFrameElement;
afterEach(() => frame?.remove());

test("the generated WebView searches its mounted stream and keeps Find commands off the input bridge", async () => {
  const messages: Message[] = [];
  frame = document.createElement("iframe");
  frame.style.width = "500px";
  frame.style.height = "300px";
  document.body.append(frame);
  const win = frame.contentWindow as TerminalFrameWindow;
  Object.assign(win, {
    ReactNativeWebView: { postMessage: (raw: string) => messages.push(JSON.parse(raw)) },
  });
  win.document.open();
  win.document.write(terminalEmulatorWebViewHtml);
  win.document.close();
  await expect.poll(() => messages.some((m) => m.type === "bridgeReady")).toBe(true);
  const send = (message: object) =>
    win.__PASEO_TERMINAL_WEBVIEW_RECEIVE__({ streamKey: "owned", ...message });
  send({
    type: "mount",
    initialSnapshot: null,
    scrollbackLines: 1000,
    theme: { background: "#ffffff", foreground: "#111111" },
    pendingModifiers: { ctrl: false, shift: false, alt: false },
    swipeGesturesEnabled: false,
  });
  await expect
    .poll(() => messages.some((m) => m.type === "rendererReady" && m.streamKey === "owned"))
    .toBe(true);
  send({ type: "writeOutput", text: "first a.b\r\n" + "padding\r\n".repeat(30) + "last A.B" });
  await expect
    .poll(() => {
      const b = win.__paseoTerminal?.buffer.active;
      return b
        ? Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true)).join(
            "\n",
          )
        : "";
    })
    .toContain("last A.B");
  send({ type: "findWidgetSize", size: { width: 356, height: 58 } });
  send({ type: "find", query: "a.b" });
  await expect
    .poll(() => messages.findLast((m) => m.type === "findResult")?.result)
    .toMatchObject({ resultCount: 2, resultIndex: 1 });
  send({ type: "find", query: "a.b", direction: "previous" });
  await expect
    .poll(() => messages.findLast((m) => m.type === "findResult")?.result)
    .toMatchObject({ resultCount: 2, resultIndex: 0 });
  send({ type: "find", streamKey: "stale", query: "absent" });
  expect(win.__paseoTerminal!.getSelection()).toBe("a.b");
  send({ type: "clearFind" });
  await expect
    .poll(() => messages.findLast((m) => m.type === "findResult")?.result)
    .toMatchObject({ resultCount: 0 });
  expect(messages.filter((m) => m.type === "input")).toEqual([]);
  send({ type: "unmount" });
});
