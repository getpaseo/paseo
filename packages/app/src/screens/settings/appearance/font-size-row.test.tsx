// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real Unistyles web runtime touches `matchMedia` at import time, which jsdom
// does not provide. Stand in a theme that answers any token lookup with a number so
// the style factories in this module tree evaluate without enumerating the tokens.
vi.mock("react-native-unistyles", () => {
  const token: unknown = new Proxy(
    {},
    {
      get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : token),
    },
  );
  return {
    StyleSheet: {
      create: (factory: unknown) => (typeof factory === "function" ? factory(token) : factory),
    },
    withUnistyles: (Component: unknown) => Component,
    useUnistyles: () => ({ theme: token, rt: { breakpoint: "lg" } }),
    UnistylesRuntime: { themeName: "dark", updateTheme: () => {} },
  };
});

import { FontSizeRow } from "./font-size-row";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root && container) {
    act(() => {
      root?.unmount();
    });
    container.remove();
  }
  root = null;
  container = null;
});

function getInput(): HTMLInputElement {
  const input = container?.querySelector("input");
  if (!input) throw new Error("size input not rendered");
  return input as HTMLInputElement;
}

/**
 * Type into the field the way a user would. React installs a value tracker on the
 * DOM node and drops change events whose value it believes it already saw, so the
 * write has to go through the native setter rather than `input.value = …`.
 */
function type(input: HTMLInputElement, text: string): void {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** React delegates `onBlur` from the bubbling `focusout` event, not `blur`. */
function blur(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

interface RenderOptions {
  draft: string;
  /** The clamped value the parent reports back on commit. */
  committed: string;
}

function renderRow({ draft, committed }: RenderOptions) {
  const onCommit = vi.fn(() => committed);
  const onChangeDraft = vi.fn();
  act(() => {
    root?.render(
      <FontSizeRow
        title="Code size"
        hint="Used for code, diffs, and terminal output"
        accessibilityLabel="Code font size"
        draft={draft}
        onChangeDraft={onChangeDraft}
        onCommit={onCommit}
      />,
    );
  });
  return { onCommit, onChangeDraft };
}

describe("FontSizeRow", () => {
  it("shows the clamped value when an out-of-range entry clamps to the stored value", () => {
    // The field is uncontrolled and the committed setting does not change, so nothing
    // else re-syncs it. Without the imperative resync the rejected 99 stays on screen.
    const { onCommit } = renderRow({ draft: "22", committed: "22" });
    const input = getInput();

    type(input, "99");
    expect(input.value).toBe("99");

    blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("22");
  });

  it("shows the clamped value when the commit does change the stored value", () => {
    const { onCommit } = renderRow({ draft: "12", committed: "22" });
    const input = getInput();

    type(input, "99");
    blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("22");
  });

  it("leaves an in-range entry exactly as typed", () => {
    const { onCommit } = renderRow({ draft: "12", committed: "18" });
    const input = getInput();

    type(input, "18");
    blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("18");
  });

  it("reports each keystroke to the parent as draft text", () => {
    const { onChangeDraft } = renderRow({ draft: "12", committed: "12" });
    const input = getInput();

    type(input, "1");
    type(input, "16");

    expect(onChangeDraft).toHaveBeenNthCalledWith(1, "1");
    expect(onChangeDraft).toHaveBeenNthCalledWith(2, "16");
  });
});
