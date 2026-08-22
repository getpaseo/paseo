import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetainedPanel } from "@/components/retained-panel";
import { StatusRing } from "@/components/status-ring";

beforeEach(() => vi.stubGlobal("React", React));

afterEach(() => vi.unstubAllGlobals());

describe("StatusRing retained panel activity", () => {
  it("animates only while its retained panel is active", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function render(active: boolean): void {
      act(() => {
        root.render(
          <RetainedPanel active={active}>
            <StatusRing />
          </RetainedPanel>,
        );
      });
    }

    function animationCount(): number {
      return [...container.querySelectorAll("*")].filter(
        (element) => element.getAnimations().length > 0,
      ).length;
    }

    render(false);
    expect(animationCount()).toBe(0);

    render(true);
    expect(animationCount()).toBe(1);

    render(false);
    expect(animationCount()).toBe(0);

    act(() => root.unmount());
    container.remove();
  });
});
