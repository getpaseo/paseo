import { useGlobalOverlayLayer } from "./overlay-root";
import { useOverlayRegistration } from "@/keyboard";
import React, { useCallback, useEffect, useRef, type RefCallback } from "react";
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

function InnerOverlay({
  active,
  restoreFocusRef,
}: {
  active: boolean;
  restoreFocusRef?: React.RefObject<unknown>;
}) {
  const setScope = useOverlayRegistration({
    keys: ["Escape"],
    active,
    layer: 20,
    onKeyDown: () => false,
    restoreFocusRef,
  });
  return active ? (
    <div ref={setScope as RefCallback<HTMLDivElement>} tabIndex={-1}>
      <input data-testid="overlay-search" />
    </div>
  ) : null;
}

function TextareaOverlayHarness({
  open,
  mountOverlay = true,
  useExplicitRestoreRef,
  events,
  selections,
}: {
  open: boolean;
  mountOverlay?: boolean;
  useExplicitRestoreRef: boolean;
  events: string[];
  selections: number[];
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const focusHandleRef = useRef<{ focus: () => void }>({
    focus: () => textareaRef.current?.focus(),
  });
  const handleFocus = useCallback(() => {
    events.push("focus");
  }, [events]);
  const handleBlur = useCallback(() => {
    events.push("blur");
  }, [events]);
  const handleSelect = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      selections.push(event.currentTarget.selectionStart);
    },
    [selections],
  );
  return (
    <div>
      <textarea
        ref={textareaRef}
        data-testid="restored-textarea"
        onFocus={handleFocus}
        onBlur={handleBlur}
        onSelect={handleSelect}
      />
      {mountOverlay ? (
        <InnerOverlay
          active={open}
          restoreFocusRef={useExplicitRestoreRef ? focusHandleRef : undefined}
        />
      ) : null}
    </div>
  );
}

function AutofocusReplacementHarness({
  open,
  showInlineInput,
  blurs,
}: {
  open: boolean;
  showInlineInput: boolean;
  blurs: string[];
}) {
  const handleBlur = useCallback(() => {
    blurs.push("blur");
  }, [blurs]);
  return (
    <div>
      <InnerOverlay active={open} />
      {showInlineInput ? (
        <input autoFocus data-testid="inline-autofocus-input" onBlur={handleBlur} />
      ) : null}
    </div>
  );
}

function PassiveFocusOrderHarness({
  open,
  openedAfterClose,
}: {
  open: boolean;
  openedAfterClose: string[];
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const onFocusIn = (event: FocusEvent) => {
      if (!open && trigger.contains(event.target as Node)) {
        openedAfterClose.push("focusin-while-enabled");
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, openedAfterClose]);

  return (
    <div>
      <button ref={triggerRef} type="button" data-testid="passive-trigger">
        Trigger
      </button>
      <InnerOverlay active={open} restoreFocusRef={triggerRef} />
    </div>
  );
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

  it("delivers React onFocus and onSelect after restoring focus to a textarea", async () => {
    const events: string[] = [];
    const selections: number[] = [];

    // Case 1: explicit restoreFocusRef handle closing via active: true -> false
    flushSync(() =>
      root.render(
        <TextareaOverlayHarness
          open={false}
          useExplicitRestoreRef
          events={events}
          selections={selections}
        />,
      ),
    );
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="restored-textarea"]',
    )!;
    textarea.focus();
    events.length = 0;
    selections.length = 0;

    flushSync(() =>
      root.render(
        <TextareaOverlayHarness
          open
          useExplicitRestoreRef
          events={events}
          selections={selections}
        />,
      ),
    );
    await nextFrame();
    document.querySelector<HTMLInputElement>('[data-testid="overlay-search"]')?.focus();
    expect(document.activeElement).not.toBe(textarea);

    flushSync(() =>
      root.render(
        <TextareaOverlayHarness
          open={false}
          useExplicitRestoreRef
          events={events}
          selections={selections}
        />,
      ),
    );
    await nextFrame();
    expect(document.activeElement).toBe(textarea);
    expect(events).toContain("focus");

    textarea.value = "/h";
    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "h", bubbles: true }));
    expect(selections).toContain(2);

    // Case 2: captured activeElement closing via unmount while active
    events.length = 0;
    selections.length = 0;
    textarea.value = "";
    textarea.setSelectionRange(0, 0);
    flushSync(() =>
      root.render(
        <TextareaOverlayHarness
          open
          mountOverlay
          useExplicitRestoreRef={false}
          events={events}
          selections={selections}
        />,
      ),
    );
    await nextFrame();
    document.querySelector<HTMLInputElement>('[data-testid="overlay-search"]')?.focus();
    expect(document.activeElement).not.toBe(textarea);

    flushSync(() =>
      root.render(
        <TextareaOverlayHarness
          open
          mountOverlay={false}
          useExplicitRestoreRef={false}
          events={events}
          selections={selections}
        />,
      ),
    );
    await nextFrame();
    expect(document.activeElement).toBe(textarea);
    expect(events).toContain("focus");

    textarea.value = "/help";
    textarea.setSelectionRange(5, 5);
    textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "p", bubbles: true }));
    expect(selections).toContain(5);
  });

  it("does not steal focus when another overlay opens in the same commit", async () => {
    function StackedHarness({ which }: { which: "first" | "second" }) {
      const firstScope = useOverlayRegistration({
        keys: ["Escape"],
        active: which === "first",
        layer: 20,
        onKeyDown: () => false,
      });
      const secondScope = useOverlayRegistration({
        keys: ["Escape"],
        active: which === "second",
        layer: 30,
        onKeyDown: () => false,
      });
      return (
        <div>
          {which === "first" ? (
            <div ref={firstScope as RefCallback<HTMLDivElement>} tabIndex={-1}>
              <input data-testid="first-input" />
            </div>
          ) : (
            <div ref={secondScope as RefCallback<HTMLDivElement>} tabIndex={-1}>
              <input data-testid="second-input" />
            </div>
          )}
        </div>
      );
    }

    flushSync(() => root.render(<StackedHarness which="first" />));
    await nextFrame();
    document.querySelector<HTMLInputElement>('[data-testid="first-input"]')?.focus();

    flushSync(() => root.render(<StackedHarness which="second" />));
    const secondInput = document.querySelector<HTMLInputElement>('[data-testid="second-input"]')!;
    secondInput.focus();
    await nextFrame();

    expect(document.activeElement).toBe(secondInput);
  });

  it("does not steal focus from an autofocused input mounted in the same commit", async () => {
    const blurs: string[] = [];

    flushSync(() =>
      root.render(<AutofocusReplacementHarness open showInlineInput={false} blurs={blurs} />),
    );
    await nextFrame();
    document.querySelector<HTMLInputElement>('[data-testid="overlay-search"]')?.focus();
    expect(document.activeElement).not.toBe(opener);

    flushSync(() =>
      root.render(<AutofocusReplacementHarness open={false} showInlineInput blurs={blurs} />),
    );
    await nextFrame();

    const inlineInput = document.querySelector<HTMLInputElement>(
      '[data-testid="inline-autofocus-input"]',
    );
    expect(inlineInput).toBeTruthy();
    expect(document.activeElement).toBe(inlineInput);
    expect(blurs).toEqual([]);
  });

  it("restores focus during layout effects before passive focusin listeners re-enable", async () => {
    const openedAfterClose: string[] = [];

    flushSync(() =>
      root.render(<PassiveFocusOrderHarness open={false} openedAfterClose={openedAfterClose} />),
    );
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="passive-trigger"]')!;
    trigger.focus();
    openedAfterClose.length = 0;

    flushSync(() =>
      root.render(<PassiveFocusOrderHarness open openedAfterClose={openedAfterClose} />),
    );
    await nextFrame();
    document.querySelector<HTMLInputElement>('[data-testid="overlay-search"]')?.focus();
    expect(document.activeElement).not.toBe(trigger);

    flushSync(() =>
      root.render(<PassiveFocusOrderHarness open={false} openedAfterClose={openedAfterClose} />),
    );
    await nextFrame();

    expect(document.activeElement).toBe(trigger);
    expect(openedAfterClose).toEqual([]);
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
      subscribeCommandCenter: () => () => {},
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
