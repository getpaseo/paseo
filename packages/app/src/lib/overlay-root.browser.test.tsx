import React, { type RefCallback } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasOpenDomPopover,
  keyBelongsToDomPopover,
  useWebOverlayRegistration,
} from "./overlay-root";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function OverlayHarness({ active, showScope }: { active: boolean; showScope: boolean }) {
  const setScope = useWebOverlayRegistration({ active, layer: 20, onKeyDown: () => false });
  return showScope ? (
    <div data-testid="scope" ref={setScope as RefCallback<HTMLDivElement>} tabIndex={-1}>
      <input data-testid="overlay-input" />
    </div>
  ) : null;
}

describe("useWebOverlayRegistration in the browser", () => {
  let root: Root;
  let container: HTMLDivElement;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    container = document.createElement("div");
    opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.append(opener, container);
    root = createRoot(container);
    opener.focus();
  });

  afterEach(() => {
    root.unmount();
    document.body.replaceChildren();
  });

  async function renderHarness(active: boolean, showScope: boolean): Promise<void> {
    flushSync(() => {
      root.render(<OverlayHarness active={active} showScope={showScope} />);
    });
    await nextFrame();
  }

  it("skips focus restoration for active scope detach but restores focus when closing", async () => {
    await renderHarness(true, true);

    const input = document.querySelector<HTMLInputElement>('[data-testid="overlay-input"]');
    expect(input).toBeTruthy();
    input?.focus();
    await nextFrame();
    expect(document.activeElement).not.toBe(opener);

    const originalFocus = opener.focus.bind(opener);
    let openerFocusCalls = 0;
    opener.focus = () => {
      openerFocusCalls += 1;
      originalFocus();
    };

    await renderHarness(true, false);

    expect(openerFocusCalls).toBe(0);

    await renderHarness(false, false);

    expect(openerFocusCalls).toBe(1);
  });
});

describe("hasOpenDomPopover", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("is true only while a popover is shown", () => {
    const panel = document.createElement("div");
    panel.setAttribute("popover", "manual");
    document.body.append(panel);
    expect(hasOpenDomPopover()).toBe(false);
    panel.showPopover();
    expect(hasOpenDomPopover()).toBe(true);
    panel.hidePopover();
    expect(hasOpenDomPopover()).toBe(false);
  });
});

describe("Escape with a plugin popover open", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("closes the popover first, and interrupts only on the next press", () => {
    // A plugin's panel: shown with the Popover API, closed by its own Escape listener.
    const panel = document.createElement("div");
    panel.setAttribute("popover", "manual");
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panel.matches(":popover-open")) panel.hidePopover();
    });
    const composer = document.createElement("textarea");
    document.body.append(composer, panel);
    // The shortcut engine: a window capture listener that interrupts on Escape.
    let interrupts = 0;
    const shortcuts = (event: KeyboardEvent) => {
      if (keyBelongsToDomPopover(event)) return;
      if (event.key === "Escape") interrupts += 1;
    };
    window.addEventListener("keydown", shortcuts, true);
    try {
      composer.focus();
      panel.showPopover();
      const escape = () =>
        composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      escape();
      expect(panel.matches(":popover-open")).toBe(false);
      expect(interrupts).toBe(0);

      escape();
      expect(interrupts).toBe(1);
    } finally {
      window.removeEventListener("keydown", shortcuts, true);
    }
  });

  it("leaves other keys to the shortcuts while a popover is open", () => {
    const panel = document.createElement("div");
    panel.setAttribute("popover", "manual");
    document.body.append(panel);
    panel.showPopover();
    expect(keyBelongsToDomPopover({ key: "Enter" })).toBe(false);
    expect(keyBelongsToDomPopover({ key: "Escape" })).toBe(true);
  });
});
