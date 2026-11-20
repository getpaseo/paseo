import { describe, expect, it, vi } from "vitest";
import {
  SCRIPT_FRAME_CSP,
  bootstrapSource,
  createPostQueue,
  deliverScript,
  parsePageMessage,
  routePageMessage,
  scriptFrameHtml,
} from "./script-frame-page";

describe("the frame's page", () => {
  it("carries the policy first, then the bootstrap, the script and the ready call, in that order", () => {
    const html = scriptFrameHtml("window.answer = 42;", "native");
    const policy = html.indexOf("Content-Security-Policy");
    const bootstrap = html.indexOf("window.paseoFrame = frame");
    const script = html.indexOf("window.answer = 42;");
    const ready = html.indexOf("__paseoFrameReady()");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(policy).toBeGreaterThan(-1);
    expect([policy < bootstrap, bootstrap < script, script < ready]).toEqual([true, true, true]);
  });

  it("has no network: the policy is the spec's, word for word", () => {
    expect(SCRIPT_FRAME_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'",
    );
    expect(scriptFrameHtml("", "web")).toContain(`content="${SCRIPT_FRAME_CSP}"`);
  });

  it("keeps a script that mentions the end of a script tag inside its own tag", () => {
    const html = scriptFrameHtml('var s = "</script><b>x</b>";', "web");
    expect(html).not.toContain('"</script>');
    expect(html).toContain('"<\\/script>');
  });

  it("sends a plugin's text to the page as a call of paseoFrame.onMessage with a JSON string", () => {
    const code = deliverScript('say "hi"\n');
    expect(code).toContain('f("say \\"hi\\"\\n")');
    expect(code.endsWith("true;")).toBe(true);
  });
});

describe("the page's side of the bridge", () => {
  function pageWindow() {
    const posted: string[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const win: Record<string, unknown> = {
      ReactNativeWebView: { postMessage: (data: string) => posted.push(data) },
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
    };
    new Function("window", bootstrapSource("native"))(win);
    return { win, posted, listeners };
  }

  it("posts a page's text as a message envelope, as a string", () => {
    const { win, posted } = pageWindow();
    (win.paseoFrame as { post(text: string): void }).post("hello");
    expect(posted.map((data) => JSON.parse(data))).toEqual([
      { paseoFrame: "message", text: "hello" },
    ]);
  });

  it("reports an error of the page as an error envelope", () => {
    const { posted, listeners } = pageWindow();
    listeners.get("error")?.({ message: "boom" });
    expect(posted.map((data) => JSON.parse(data))).toEqual([
      { paseoFrame: "error", message: "boom" },
    ]);
  });

  it("says ready once the page calls the ready hook", () => {
    const { win, posted } = pageWindow();
    (win.__paseoFrameReady as () => void)();
    expect(posted.map((data) => JSON.parse(data))).toEqual([{ paseoFrame: "ready" }]);
  });
});

describe("parsing what a page sent", () => {
  it.each([
    [{ paseoFrame: "ready" }, { paseoFrame: "ready" }],
    [
      { paseoFrame: "message", text: "a" },
      { paseoFrame: "message", text: "a" },
    ],
    [
      { paseoFrame: "error", message: "m" },
      { paseoFrame: "error", message: "m" },
    ],
  ])("reads %j", (value, expected) => {
    expect(parsePageMessage(value)).toEqual(expected);
  });

  it.each([
    null,
    "text",
    4,
    {},
    { paseoFrame: "message" },
    { paseoFrame: "message", text: 4 },
    { paseoFrame: "other" },
  ])("ignores %j", (value) => {
    expect(parsePageMessage(value)).toBeNull();
  });
});

describe("the post queue", () => {
  it("holds posts until the page is ready and then delivers them in order", () => {
    const sent: string[] = [];
    const queue = createPostQueue((text) => sent.push(text));
    queue.post("a");
    queue.post("b");
    expect(sent).toEqual([]);
    queue.ready();
    expect(sent).toEqual(["a", "b"]);
    queue.post("c");
    expect(sent).toEqual(["a", "b", "c"]);
  });

  it("delivers nothing twice when the page says ready twice", () => {
    const sent: string[] = [];
    const queue = createPostQueue((text) => sent.push(text));
    queue.post("a");
    queue.ready();
    queue.ready();
    expect(sent).toEqual(["a"]);
  });

  it("waits again after a reset, keeping what was posted meanwhile", () => {
    const sent: string[] = [];
    const queue = createPostQueue((text) => sent.push(text));
    queue.ready();
    queue.reset();
    queue.post("late");
    expect(sent).toEqual([]);
    queue.ready();
    expect(sent).toEqual(["late"]);
  });
});

describe("routing a page's message", () => {
  it("opens the queue on ready, hands text to onMessage and errors to onError", () => {
    const sent: string[] = [];
    const queue = createPostQueue((text) => sent.push(text));
    const onMessage = vi.fn();
    const onError = vi.fn();
    queue.post("first");
    routePageMessage({ paseoFrame: "ready" }, queue, { onMessage, onError });
    routePageMessage({ paseoFrame: "message", text: "from page" }, queue, { onMessage, onError });
    routePageMessage({ paseoFrame: "error", message: "bad" }, queue, { onMessage, onError });
    expect(sent).toEqual(["first"]);
    expect(onMessage).toHaveBeenCalledWith("from page");
    expect(onError).toHaveBeenCalledWith("bad");
  });
});
