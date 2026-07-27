/**
 * @vitest-environment jsdom
 */
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebOverlayRegistration } from "./overlay-root";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

function OverlayScope({
  layer,
  onEscape,
  children,
}: {
  layer: number;
  onEscape: () => void;
  children: ReactNode;
}) {
  const setScope = useWebOverlayRegistration({
    active: true,
    layer,
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      onEscape();
      return true;
    },
  });

  return (
    <div ref={setScope} tabIndex={-1}>
      {children}
    </div>
  );
}

describe("web overlay registration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("preserves autofocus and keyboard ownership for a newly mounted higher scope", () => {
    const lowerEscape = vi.fn();
    const upperEscape = vi.fn();

    act(() => {
      root.render(
        <OverlayScope layer={10} onEscape={lowerEscape}>
          <input data-testid="lower" autoFocus />
        </OverlayScope>,
      );
    });
    const lowerInput = container.querySelector('[data-testid="lower"]');
    expect(document.activeElement).toBe(lowerInput);

    act(() => {
      root.render(
        <>
          <OverlayScope layer={10} onEscape={lowerEscape}>
            <input data-testid="lower" autoFocus />
          </OverlayScope>
          <OverlayScope layer={20} onEscape={upperEscape}>
            <input data-testid="upper" autoFocus />
          </OverlayScope>
        </>,
      );
    });

    expect(document.activeElement).toBe(container.querySelector('[data-testid="upper"]'));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(upperEscape).toHaveBeenCalledOnce();
    expect(lowerEscape).not.toHaveBeenCalled();
  });
});
