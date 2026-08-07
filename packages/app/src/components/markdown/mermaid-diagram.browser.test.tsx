import { page } from "@vitest/browser/context";
import { cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MermaidDiagram } from "./mermaid-diagram";

afterEach(cleanup);

// Real gantt source (trimmed from docs/projects/mordor/DASHBOARD.md) exercising
// the same shape of fence a Paseo user would paste from a repo's markdown docs.
const GANTT_SOURCE = `gantt
    title QA proof - mermaid fence renders as SVG
    dateFormat YYYY-MM-DD
    section Proof
    Diagram renders inline :done, Proof, 2026-08-01, 2026-08-02
`;

describe("MermaidDiagram (web)", () => {
  it("renders a mermaid gantt fence as an inline SVG diagram, not the raw source", async () => {
    const { container } = render(
      <MermaidDiagram
        code={GANTT_SOURCE}
        // oxlint-disable-next-line react-perf/jsx-no-jsx-as-prop
        fallback={<div data-testid="fallback">fallback code block</div>}
      />,
    );

    const svg = await waitFor(() => {
      const el = container.querySelector("svg");
      if (!el) throw new Error("mermaid SVG not rendered yet");
      return el;
    });

    expect(svg.getAttribute("aria-roledescription")).toBe("gantt");
    expect(container.textContent).toContain("Proof");
    expect(container.querySelector('[data-testid="fallback"]')).toBeNull();

    // Real, inspectable QA artifact — a Chromium screenshot of the diagram
    // actually rendering, saved under packages/app/.vitest-screenshots/.
    await page.screenshot();
  });

  it("falls back to the provided fallback when the mermaid source is invalid", async () => {
    const { container, getByTestId } = render(
      <MermaidDiagram
        code="this is not a valid mermaid diagram"
        // oxlint-disable-next-line react-perf/jsx-no-jsx-as-prop
        fallback={<div data-testid="fallback">fallback code block</div>}
      />,
    );

    await waitFor(() => expect(getByTestId("fallback")).toBeTruthy());
    expect(container.querySelector("svg")).toBeNull();
  });
});
