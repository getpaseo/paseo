// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hasOpenWebOverlay, useWebOverlayRegistration } from "./overlay-root";

// Regression for the Escape-interrupt fix. Focus-trapping overlays (dialogs,
// dropdowns, comboboxes) register here, and the keyboard dispatcher reads
// `hasOpenWebOverlay()` to stand down from the Escape-bound `agent.interrupt`
// while one of them owns Escape. If registration stops flipping this query,
// cancelling a dialog with Escape silently interrupts the running agent again.
describe("hasOpenWebOverlay", () => {
  function renderOverlay(active: boolean) {
    return renderHook(
      ({ active: isActive }: { active: boolean }) => {
        const setScope = useWebOverlayRegistration({
          active: isActive,
          layer: 20,
          onKeyDown: () => false,
        });
        return setScope;
      },
      { initialProps: { active } },
    );
  }

  it("reports no overlay before anything registers", () => {
    expect(hasOpenWebOverlay()).toBe(false);
  });

  it("stays closed while active but without a focus scope", () => {
    const { result, unmount } = renderOverlay(true);
    void result.current;
    expect(hasOpenWebOverlay()).toBe(false);
    unmount();
  });

  it("opens once an active overlay attaches its scope, and closes on unmount", () => {
    const { result, unmount } = renderOverlay(true);
    result.current(document.createElement("div"));
    expect(hasOpenWebOverlay()).toBe(true);

    unmount();
    expect(hasOpenWebOverlay()).toBe(false);
  });

  it("closes when the overlay goes inactive without unmounting", () => {
    const { result, rerender, unmount } = renderOverlay(true);
    result.current(document.createElement("div"));
    expect(hasOpenWebOverlay()).toBe(true);

    rerender({ active: false });
    expect(hasOpenWebOverlay()).toBe(false);
    unmount();
  });
});
