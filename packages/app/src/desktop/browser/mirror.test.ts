// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  mirrorReplaySource,
  replayMirrorAction,
  publishBrowserMirror,
  subscribeBrowserMirrorReplay,
  MIRROR_ORIGIN,
  mirrorReplayReadySource,
} from "./mirror";

describe("replayMirrorAction", () => {
  it("fills and submits the local form the daemon filled", () => {
    document.body.innerHTML = `<form id="f"><input id="email"><input type="password" id="pw"><button id="go">Sign in</button></form>`;
    let submitted = false;
    const form = document.getElementById("f") as HTMLFormElement;
    form.requestSubmit = () => {
      submitted = true;
    };
    expect(
      replayMirrorAction({ kind: "fill", target: { selector: "#email" }, value: "me@x.de" }),
    ).toBe(true);
    expect((document.getElementById("email") as HTMLInputElement).value).toBe("me@x.de");
    // A password arrives without its value; the field only gets focus.
    expect(replayMirrorAction({ kind: "fill", target: { selector: "#pw" } })).toBe(true);
    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("");
    expect(document.activeElement?.id).toBe("pw");
    replayMirrorAction({ kind: "keypress", target: { selector: "#email" }, key: "Enter" });
    expect(submitted).toBe(true);
  });

  it("falls back to the accessible name and skips what the page lacks", () => {
    document.body.innerHTML = `<div><button aria-label="Weiter">→</button></div>`;
    let clicks = 0;
    document.querySelector("button")?.addEventListener("click", () => (clicks += 1));
    expect(
      replayMirrorAction({
        kind: "click",
        target: { selector: "#gone", role: "button", name: "Weiter" },
      }),
    ).toBe(true);
    expect(clicks).toBe(1);
    expect(replayMirrorAction({ kind: "click", target: { selector: "#gone", name: "Nope" } })).toBe(
      false,
    );
  });

  it("builds a self-contained source for the page", () => {
    document.body.innerHTML = `<input id="q">`;
    const run = (0, eval)(
      `(${mirrorReplaySource({ kind: "type", target: { selector: "#q" }, text: "hi" })})`,
    );
    expect(run()).toBe(true);
    expect((document.getElementById("q") as HTMLInputElement).value).toBe("hi");
  });
});

describe("late local browser replay", () => {
  it("replays retained navigation and input once, in order, including after resubscription", async () => {
    const event = (
      at: number,
      action: Parameters<typeof publishBrowserMirror>[1]["action"],
      origin?: string,
    ) => ({ workspaceId: "workspace", browserId: "late", at, action, origin });
    publishBrowserMirror("host", event(1, { kind: "navigate", url: "https://example.com" }));
    publishBrowserMirror(
      "host",
      event(2, { kind: "fill", target: { selector: "#q" }, value: "ready" }),
    );
    const calls: string[] = [];
    const cursor = { at: 0 };
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const input = {
      serverId: "host",
      browserId: "late",
      cursor,
      replay: async (action: Parameters<typeof event>[1]) => {
        calls.push(action.kind);
        if (action.kind === "fill") finish();
      },
      onError: (error: unknown) => {
        throw error;
      },
    };
    let stop = subscribeBrowserMirrorReplay(input);
    await completed;
    await Promise.resolve();
    stop();
    stop = subscribeBrowserMirrorReplay(input);
    publishBrowserMirror(
      "host",
      event(2, { kind: "fill", target: { selector: "#q" }, value: "ready" }),
    );
    publishBrowserMirror(
      "host",
      event(3, { kind: "click", target: { selector: "#q" } }, MIRROR_ORIGIN),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["navigate", "fill"]);
    expect(cursor.at).toBe(3);
    stop();
  });

  it("waits for a control rendered after replay begins", async () => {
    document.body.innerHTML = "";
    const run = (0, eval)(
      `(${mirrorReplayReadySource({ kind: "fill", target: { selector: "#late" }, value: "hello" })})`,
    );
    const done = run();
    document.body.innerHTML = '<input id="late">';
    expect(await done).toBe(true);
    expect((document.getElementById("late") as HTMLInputElement).value).toBe("hello");
  });
});
