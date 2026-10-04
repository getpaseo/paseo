import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptSuggestionChips } from "./chips";

const SUGGESTIONS = [
  { id: "s2", text: "open a PR for the auth fix" },
  { id: "s3", text: "explain the diff" },
];

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("PromptSuggestionChips", () => {
  it("renders one chip per suggestion", () => {
    const container = mount(<PromptSuggestionChips suggestions={SUGGESTIONS} onSelect={vi.fn()} />);

    expect(container.textContent).toContain("open a PR for the auth fix");
    expect(container.textContent).toContain("explain the diff");
  });

  it("hands the pressed suggestion's text to onSelect", () => {
    const onSelect = vi.fn();
    const container = mount(
      <PromptSuggestionChips suggestions={SUGGESTIONS} onSelect={onSelect} />,
    );
    const chip = [...container.querySelectorAll('[role="button"]')].find((node) =>
      node.textContent?.includes("explain the diff"),
    );

    expect(chip).toBeDefined();
    act(() => (chip as HTMLElement).click());

    expect(onSelect).toHaveBeenCalledWith("explain the diff");
  });

  it("renders nothing when there are no suggestions", () => {
    const container = mount(<PromptSuggestionChips suggestions={[]} onSelect={vi.fn()} />);

    expect(container.textContent).toBe("");
  });
});
