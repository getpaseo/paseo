/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@gorhom/bottom-sheet", () => ({
  BottomSheetModalProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-bottom-sheet-provider": true }, children),
  BottomSheetModal: React.forwardRef(
    (
      {
        children,
        stackBehavior,
      }: {
        children?: React.ReactNode;
        stackBehavior?: string;
      },
      _ref,
    ) => React.createElement("div", { "data-stack-behavior": stackBehavior }, children),
  ),
}));

import {
  IsolatedBottomSheetModal,
  useIsInsideBottomSheetInputScope,
} from "@/components/ui/isolated-bottom-sheet-modal";

function ScopeProbe() {
  const inside = useIsInsideBottomSheetInputScope();
  return React.createElement("div", {
    "data-testid": "scope-probe",
    "data-inside": String(inside),
  });
}

describe("bottom sheet input scope", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("is outside sheet scope by default", () => {
    act(() => {
      root.render(React.createElement(ScopeProbe));
    });
    expect(
      container.querySelector("[data-testid='scope-probe']")?.getAttribute("data-inside"),
    ).toBe("false");
  });

  it("marks descendants of IsolatedBottomSheetModal as inside sheet scope", () => {
    act(() => {
      root.render(
        React.createElement(IsolatedBottomSheetModal, null, React.createElement(ScopeProbe)),
      );
    });
    expect(
      container.querySelector("[data-testid='scope-probe']")?.getAttribute("data-inside"),
    ).toBe("true");
  });
});
