import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { dispatchTopOverlayKeyDown } from "@/keyboard";
import { useComposerFullscreenExit } from "./fullscreen-exit";

it("the native entry claims Escape until fullscreen closes", () => {
  let exits = 0;
  function Harness({ active }: { active: boolean }) {
    useComposerFullscreenExit(active, () => exits++);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Harness active />));
    expect(dispatchTopOverlayKeyDown(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
    expect(exits).toBe(1);
    flushSync(() => root.render(<Harness active={false} />));
    expect(dispatchTopOverlayKeyDown(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
    expect(exits).toBe(1);
  } finally {
    root.unmount();
    container.remove();
  }
});
