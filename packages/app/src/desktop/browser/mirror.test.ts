// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mirrorReplaySource, replayMirrorAction } from "./mirror";

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
