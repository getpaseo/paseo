/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import type { DictationStatus } from "@/hooks/use-dictation";
import {
  isTerminalKeyboardOwner,
  resolveTerminalDictationLifecycle,
} from "./terminal-dictation-lifecycle";

describe("resolveTerminalDictationLifecycle", () => {
  const active: DictationStatus[] = ["recording", "paused", "uploading"];

  it("keeps an idle terminal whatever happens to it", () => {
    expect(
      resolveTerminalDictationLifecycle({
        isPresented: false,
        isRecordingOwner: false,
        status: "idle",
      }),
    ).toBe("keep");
  });

  it.each(active)("keeps a presented recording owner while %s", (status) => {
    expect(
      resolveTerminalDictationLifecycle({ isPresented: true, isRecordingOwner: true, status }),
    ).toBe("keep");
  });

  it.each(active)("cancels when the terminal stops being presented while %s", (status) => {
    expect(
      resolveTerminalDictationLifecycle({ isPresented: false, isRecordingOwner: true, status }),
    ).toBe("cancel");
  });

  it.each(active)("cancels when another terminal takes the recording while %s", (status) => {
    expect(
      resolveTerminalDictationLifecycle({ isPresented: true, isRecordingOwner: false, status }),
    ).toBe("cancel");
  });

  it("discards a failed attempt once hidden or superseded", () => {
    expect(
      resolveTerminalDictationLifecycle({
        isPresented: false,
        isRecordingOwner: true,
        status: "failed",
      }),
    ).toBe("discard");
    expect(
      resolveTerminalDictationLifecycle({
        isPresented: true,
        isRecordingOwner: false,
        status: "failed",
      }),
    ).toBe("discard");
  });
});

describe("isTerminalKeyboardOwner", () => {
  function surfaceWithInput() {
    const surface = document.createElement("div");
    const input = document.createElement("textarea");
    surface.append(input);
    document.body.append(surface);
    return { surface, input };
  }

  it("is true when focus is inside the surface", () => {
    const { surface, input } = surfaceWithInput();
    expect(isTerminalKeyboardOwner(surface, input)).toBe(true);
    surface.remove();
  });

  it("is false when focus is in another surface", () => {
    const first = surfaceWithInput();
    const second = surfaceWithInput();
    expect(isTerminalKeyboardOwner(first.surface, second.input)).toBe(false);
    first.surface.remove();
    second.surface.remove();
  });

  it("is false without a surface or a focused element", () => {
    const { surface, input } = surfaceWithInput();
    expect(isTerminalKeyboardOwner(surface, null)).toBe(false);
    expect(isTerminalKeyboardOwner(null, input)).toBe(false);
    surface.remove();
  });
});
