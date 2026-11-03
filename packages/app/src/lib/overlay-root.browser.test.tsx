import { useGlobalOverlayLayer } from "./overlay-root";
import { useOverlayRegistration } from "@/keyboard";
import React, { type RefCallback } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasOpenDomPopover, keyBelongsToDomPopover } from "@/keyboard/internal/dom-popover";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function OverlayHarness({ active, showScope }: { active: boolean; showScope: boolean }) {
  const setScope = useOverlayRegistration({
    keys: ["Escape"],
    active,
    layer: 20,
    onKeyDown: () => false,
  });
  return showScope ? (
    <div data-testid="scope" ref={setScope as RefCallback<HTMLDivElement>} tabIndex={-1}>
      <input data-testid="overlay-input" />
    </div>
  ) : null;
}

describe("useOverlayRegistration in the browser", () => {
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

  it("leaves other keys to the shortcuts while a popover is open", () => {
    const panel = document.createElement("div");
    panel.setAttribute("popover", "manual");
    document.body.append(panel);
    panel.showPopover();
    expect(keyBelongsToDomPopover({ key: "Enter" })).toBe(false);
    expect(keyBelongsToDomPopover({ key: "Escape" })).toBe(true);
  });
});

describe("DOM source through the shared resolver", () => {
  it("uses user rebinds from a focused composer and cancels the DOM default", async () => {
    const { attachDomKeyboardSource } = await import("@/keyboard/internal/sources/dom.web");
    const { createKeyboardPipeline } = await import("@/keyboard/internal/pipeline");
    const { createOverlayRegistry } = await import("@/keyboard/internal/overlays");
    const { buildEffectiveBindings } = await import("@/keyboard/keyboard-shortcuts");
    const actions: string[] = [];
    const input = document.createElement("textarea");
    input.dataset.testid = "message-input-root";
    document.body.append(input);
    input.focus();
    const pipeline = createKeyboardPipeline({
      getContext: () => ({ isMac: true, usesDesktopBindings: false, commandCenterOpen: false }),
      getBindings: () => buildEffectiveBindings({ "command-center-toggle-cmd-k-mac": "Cmd+J" }),
      isCapturing: () => false,
      overlays: createOverlayRegistry(),
      dispatch: (match) => {
        actions.push(match.action);
        return true;
      },
    });
    const detach = attachDomKeyboardSource({
      keyDown: pipeline.keyDown,
      keyUp() {},
      blur() {},
      commandCenterOpen: () => false,
    });
    const event = new KeyboardEvent("keydown", {
      key: "j",
      code: "KeyJ",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    expect(actions).toEqual(["command-center.toggle"]);
    expect(event.defaultPrevented).toBe(true);
    detach();
    pipeline.dispose();
    input.remove();
  });
});

it("recognizes a hardware keyboard from modified input without a fine pointer", async () => {
  const { createWebHardwareKeyboardPresence } = await import("@/keyboard/internal/presence.web");
  const presence = createWebHardwareKeyboardPresence(window.matchMedia("(width: 0px)"), window);
  const values: boolean[] = [];
  const release = presence.subscribe(() => values.push(presence.getSnapshot()));
  expect(presence.getSnapshot()).toBe(false);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA" }));
  expect(presence.getSnapshot()).toBe(false);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true }));
  expect(presence.getSnapshot()).toBe(true);
  expect(values).toEqual([true]);
  release();
});

function LayerHarness({ active, child }: { active: boolean; child: boolean }) {
  const layer = useGlobalOverlayLayer("modal", active);
  useOverlayRegistration({
    active: child,
    layer: 200,
    keys: ["Escape"],
    manageFocus: false,
    onKeyDown: () => false,
  });
  return <span data-testid="layer">{layer}</span>;
}

it("keeps the opening layer across rerenders and captures a new layer on reopening", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function render(active: boolean, child: boolean) {
    flushSync(() => root.render(<LayerHarness active={active} child={child} />));
    return container.textContent;
  }
  try {
    expect(render(false, false)).toBe("20");
    expect(render(true, false)).toBe("20");
    expect(render(true, true)).toBe("20");
    expect(render(true, true)).toBe("20");
    render(false, true);
    expect(render(true, true)).toBe("220");
  } finally {
    root.unmount();
    container.remove();
  }
});
