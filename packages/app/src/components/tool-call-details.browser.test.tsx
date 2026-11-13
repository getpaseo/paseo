import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { ToolCallDetailsContent } from "./tool-call-details";

// Load the real app translations so the rendered text matches what users see.
void testI18n;

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mountEmptyDetails(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ToolCallDetailsContent />));
  mounted.push({ root, container });

  const text = container.firstElementChild as HTMLElement | null;
  if (!text) throw new Error("Empty tool-call details did not render");
  return text;
}

describe("ToolCallDetailsContent empty state", () => {
  it("insets the empty message to align with the tool-call sheet header", () => {
    const text = mountEmptyDetails();

    expect(text.textContent).toBe("No additional details available");
    expect(text.style.paddingLeft).toBe("16px");
    expect(text.style.paddingRight).toBe("16px");
  });
});
