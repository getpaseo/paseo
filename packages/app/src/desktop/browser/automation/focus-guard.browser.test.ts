import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginAgentInputFocusGuard,
  clearAgentInputFocusGuards,
  endAgentInputFocusGuard,
  isAgentInputMovingFocus,
  watchUserComposition,
} from "./focus-guard";

function createFocusableWebview(browserId: string): HTMLElement {
  const webview = document.createElement("webview");
  webview.setAttribute("data-paseo-browser-id", browserId);
  webview.tabIndex = 0;
  document.body.appendChild(webview);
  return webview;
}

describe("renderer agent input focus guard", () => {
  afterEach(() => {
    clearAgentInputFocusGuards();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("restores the composer immediately and on the 50ms late-focus recheck", () => {
    vi.useFakeTimers();
    const composer = document.createElement("textarea");
    const webview = createFocusableWebview("browser-1");
    document.body.appendChild(composer);
    composer.focus();

    expect(beginAgentInputFocusGuard("browser-1", "tok-1", () => webview)).toBe("ready");
    expect(isAgentInputMovingFocus("browser-1")).toBe(true);
    expect(isAgentInputMovingFocus()).toBe(true);

    // Simulate CDP mousePressed moving focus into the webview.
    webview.focus();
    expect(document.activeElement).toBe(webview);

    endAgentInputFocusGuard("tok-1");
    expect(document.activeElement).toBe(composer);
    expect(isAgentInputMovingFocus("browser-1")).toBe(true);

    // Simulate a late Chromium focus event arriving within the 50ms recheck window.
    webview.focus();
    expect(document.activeElement).toBe(webview);

    vi.advanceTimersByTime(50);
    expect(document.activeElement).toBe(composer);
    expect(isAgentInputMovingFocus("browser-1")).toBe(false);
    expect(isAgentInputMovingFocus()).toBe(false);
  });

  it("restores the composer when a parked inert surface blurs focus to document.body", () => {
    vi.useFakeTimers();
    const composer = document.createElement("textarea");
    const surface = document.createElement("div");
    surface.setAttribute("inert", "");
    surface.setAttribute("tabindex", "-1");
    const webview = document.createElement("webview");
    surface.appendChild(webview);
    document.body.append(composer, surface);
    composer.focus();

    expect(beginAgentInputFocusGuard("browser-parked", "tok-parked", () => webview)).toBe("ready");

    // Simulate Chromium blurring composer to body while the parked webview is inert.
    composer.blur();
    expect(document.activeElement).toBe(document.body);

    endAgentInputFocusGuard("tok-parked");
    expect(document.activeElement).toBe(composer);

    vi.advanceTimersByTime(50);
    expect(isAgentInputMovingFocus("browser-parked")).toBe(false);
  });

  it("keeps focus on the webview when the user was already focused in it", () => {
    const webview = createFocusableWebview("browser-active");
    webview.focus();

    expect(beginAgentInputFocusGuard("browser-active", "tok-active", () => webview)).toBe("ready");
    expect(isAgentInputMovingFocus("browser-active")).toBe(false);

    endAgentInputFocusGuard("tok-active");
    expect(document.activeElement).toBe(webview);
  });

  it("does not yank focus back if the user focused another host input mid-press", () => {
    vi.useFakeTimers();
    const composer = document.createElement("textarea");
    const searchInput = document.createElement("input");
    const webview = createFocusableWebview("browser-other");
    document.body.append(composer, searchInput);
    composer.focus();

    expect(beginAgentInputFocusGuard("browser-other", "tok-other", () => webview)).toBe("ready");
    searchInput.focus();

    endAgentInputFocusGuard("tok-other");
    vi.advanceTimersByTime(50);
    expect(document.activeElement).toBe(searchInput);
  });

  it("preserves the original composer across overlapping presses on two webviews", () => {
    vi.useFakeTimers();
    const composer = document.createElement("textarea");
    const webviewA = createFocusableWebview("browser-a");
    const webviewB = createFocusableWebview("browser-b");
    document.body.appendChild(composer);
    composer.focus();

    expect(beginAgentInputFocusGuard("browser-a", "tok-a", () => webviewA)).toBe("ready");
    webviewA.focus();

    // Second overlapping press starts while webviewA holds agent-taken focus.
    expect(beginAgentInputFocusGuard("browser-b", "tok-b", () => webviewB)).toBe("ready");
    webviewB.focus();

    endAgentInputFocusGuard("tok-b");
    expect(document.activeElement).toBe(composer);

    endAgentInputFocusGuard("tok-a");
    vi.advanceTimersByTime(50);
    expect(document.activeElement).toBe(composer);
    expect(isAgentInputMovingFocus()).toBe(false);
  });

  it("blurs the webview when the saved host element was removed before release", () => {
    vi.useFakeTimers();
    const composer = document.createElement("textarea");
    const webview = createFocusableWebview("browser-removed");
    document.body.appendChild(composer);
    composer.focus();

    expect(beginAgentInputFocusGuard("browser-removed", "tok-removed", () => webview)).toBe(
      "ready",
    );
    webview.focus();
    composer.remove();

    endAgentInputFocusGuard("tok-removed");
    expect(document.activeElement).not.toBe(webview);
    vi.advanceTimersByTime(50);
    expect(isAgentInputMovingFocus()).toBe(false);
  });

  it("refuses pointer input while the user has an active IME composition in the composer", () => {
    const unwatch = watchUserComposition();
    try {
      const composer = document.createElement("textarea");
      const webview = createFocusableWebview("browser-ime");
      document.body.appendChild(composer);
      composer.focus();

      composer.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      expect(beginAgentInputFocusGuard("browser-ime", "tok-ime-1", () => webview)).toBe(
        "composing",
      );
      expect(isAgentInputMovingFocus("browser-ime")).toBe(false);

      // Empty compositionupdate (Sogou/fcitx) must not end the composition guard.
      composer.dispatchEvent(
        new CompositionEvent("compositionupdate", { bubbles: true, data: "" }),
      );
      expect(beginAgentInputFocusGuard("browser-ime", "tok-ime-2", () => webview)).toBe(
        "composing",
      );

      // Composition-owned input event must keep the guard active.
      composer.dispatchEvent(
        new InputEvent("input", { bubbles: true, isComposing: true, data: "あ" }),
      );
      expect(beginAgentInputFocusGuard("browser-ime", "tok-ime-3", () => webview)).toBe(
        "composing",
      );

      // Composition end allows pointer input again.
      composer.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      expect(beginAgentInputFocusGuard("browser-ime", "tok-ime-4", () => webview)).toBe("ready");
      endAgentInputFocusGuard("tok-ime-4");
    } finally {
      unwatch();
    }
  });

  it("starts IME protection on nonempty compositionupdate and clears it on non-composing input", () => {
    const unwatch = watchUserComposition();
    try {
      const composer = document.createElement("textarea");
      const webview = createFocusableWebview("browser-ime-2");
      document.body.appendChild(composer);
      composer.focus();

      composer.dispatchEvent(
        new CompositionEvent("compositionupdate", { bubbles: true, data: "漢" }),
      );
      expect(beginAgentInputFocusGuard("browser-ime-2", "tok-u1", () => webview)).toBe("composing");

      // Missed compositionend is recovered by a normal non-composing input event.
      composer.dispatchEvent(
        new InputEvent("input", { bubbles: true, isComposing: false, data: "a" }),
      );
      expect(beginAgentInputFocusGuard("browser-ime-2", "tok-u2", () => webview)).toBe("ready");
      endAgentInputFocusGuard("tok-u2");
    } finally {
      unwatch();
    }
  });
});
