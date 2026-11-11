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
