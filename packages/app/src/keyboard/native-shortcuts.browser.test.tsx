import React from "react";
import { describe, expect, it } from "vitest";
import { buildEffectiveBindings } from "./keyboard-shortcuts";
import { createKeyboardPipeline } from "./internal/pipeline";
import { createOverlayRegistry } from "./internal/overlays";
describe("DOM source adapter", () => {
  it("runs DOM input through the same resolver, preserving cancellation and cleanup", async () => {
    const { attachDomKeyboardSource } = await import("./internal/sources/dom.web");
    const actions: string[] = [];
    const input = document.createElement("textarea");
    input.dataset.testid = "message-input";
    document.body.append(input);
    input.focus();
    const pipeline = createKeyboardPipeline({
      getContext: () => ({ isMac: true, usesDesktopBindings: false, commandCenterOpen: false }),
      getBindings: () => buildEffectiveBindings({ "command-center-toggle-cmd-k-mac": "Cmd+J" }),
      isCapturing: () => false,
      dispatch: (match) => {
        actions.push(match.action);
        return true;
      },
      overlays: createOverlayRegistry(),
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
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", code: "KeyJ", metaKey: true, bubbles: true }),
    );
    expect(actions).toHaveLength(1);
    input.remove();
    pipeline.dispose();
  });
});

it("releases a hidden retained owner's overlay keys while its scope stays mounted", async () => {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RetainedPanelActivity } = await import("@/components/retained-panel");
  const { getTopOverlayKeys, hasActiveOverlay } = await import("./index");
  // Exercise the native adapter itself in a real React renderer, bypassing Vite's .web resolution.
  const nativeAdapterPath = "./internal/overlay-registration.ts";
  const { useOverlayRegistration } = (await import(
    /* @vite-ignore */ nativeAdapterPath
  )) as typeof import("./internal/overlay-registration");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Viewer() {
    const scope = useOverlayRegistration({
      active: true,
      layer: 100,
      keys: ["Escape"],
      manageFocus: false,
      onKeyDown: () => true,
    });
    return createElement("button", { ref: scope, type: "button" }, "Viewer");
  }
  async function render(active: boolean) {
    await act(async () =>
      root.render(
        <RetainedPanelActivity active={active}>
          <Viewer />
        </RetainedPanelActivity>,
      ),
    );
  }
  try {
    await render(true);
    expect(getTopOverlayKeys()).toEqual(["Escape"]);
    await render(false);
    expect(container.querySelector("button")).not.toBeNull();
    expect(hasActiveOverlay()).toBe(false);
    expect(getTopOverlayKeys()).toEqual([]);
    await render(true);
    expect(getTopOverlayKeys()).toEqual(["Escape"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
