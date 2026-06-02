/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@gorhom/portal", () => ({
  Portal: ({ children, hostName }: { children?: React.ReactNode; hostName?: string }) =>
    React.createElement("div", { "data-portal-host": hostName }, children),
  PortalHost: ({ name }: { name?: string }) => React.createElement("div", { "data-host": name }),
}));

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

import { IsolatedBottomSheetModal } from ".";

describe("IsolatedBottomSheetModal presentation", () => {
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

  it("defaults sibling top-level sheets to push instead of replacing by React ancestry", () => {
    act(() => {
      root.render(
        <>
          <IsolatedBottomSheetModal>Settings</IsolatedBottomSheetModal>
          <IsolatedBottomSheetModal>Diagnostic</IsolatedBottomSheetModal>
        </>,
      );
    });

    expect(
      Array.from(container.querySelectorAll("[data-stack-behavior]")).map((node) =>
        node.getAttribute("data-stack-behavior"),
      ),
    ).toEqual(["push", "push"]);
  });

  it("only replaces when the callsite asks for replacement", () => {
    act(() => {
      root.render(
        <IsolatedBottomSheetModal presentation="replace">Selector</IsolatedBottomSheetModal>,
      );
    });

    expect(
      container.querySelector("[data-stack-behavior]")?.getAttribute("data-stack-behavior"),
    ).toBe("replace");
  });
});
