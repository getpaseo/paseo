// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getLastHostFocus, trackLastHostFocus } from "./last-host-focus";

describe("last host focus", () => {
  it("keeps the composer as the last host focus when a webview takes focus", () => {
    trackLastHostFocus();
    const composer = document.createElement("textarea");
    const webview = document.createElement("webview");
    webview.tabIndex = 0;
    document.body.append(composer, webview);

    composer.focus();
    webview.focus();

    expect(getLastHostFocus()).toBe(composer);
  });

  it("forgets an element removed from the document", () => {
    trackLastHostFocus();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    input.remove();

    expect(getLastHostFocus()).toBeNull();
  });
});
