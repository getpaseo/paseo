import { JSDOM } from "jsdom";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInputFocus } from "./use-input-focus";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useInputFocus", () => {
  it("requests focus each time an input becomes active", () => {
    let focused = false;
    const focus = vi.fn(() => {
      focused = true;
    });
    const input = {
      focus,
      isFocused: () => focused,
    };

    function Harness({ active }: { active: boolean }) {
      const inputRef = useRef(input);
      useInputFocus(inputRef, active);
      return null;
    }

    act(() => root.render(<Harness active={false} />));
    expect(focus).not.toHaveBeenCalled();

    act(() => root.render(<Harness active />));
    expect(focus).toHaveBeenCalledTimes(1);

    focused = false;
    act(() => root.render(<Harness active={false} />));
    act(() => root.render(<Harness active />));
    expect(focus).toHaveBeenCalledTimes(2);
  });
});
