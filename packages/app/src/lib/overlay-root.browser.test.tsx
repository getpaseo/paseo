import React, { type RefCallback } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWebOverlayRegistration } from "./overlay-root";

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
