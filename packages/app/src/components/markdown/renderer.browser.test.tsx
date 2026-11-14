import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import katex from "katex";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { within, waitFor } from "@testing-library/dom";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownRenderer } from "./renderer";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

// The library loads KaTeX through a CJS require, which the browser module scope
// does not provide. Hand it the same module a bundler resolves in production.
beforeAll(() => {
  vi.stubGlobal("require", (id: string) => (id === "katex" ? katex : undefined));
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(text: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MarkdownRenderer text={text} />
      </QueryClientProvider>,
    );
  });
}

const view = () => within(container);

/**
 * Waits for the equation element that actually contains KaTeX's MathML. Before
 * KaTeX loads the same element is a plain-text fallback, which must not count.
 */
async function waitForMath(ariaLabel: string) {
  const find = () =>
    view()
      .getAllByRole("math", { name: ariaLabel })
      .find((el) => el.querySelector("math") !== null);
  await waitFor(() => expect(find()).toBeTruthy());
  return find()!;
}

describe("MarkdownRenderer math (web)", () => {
  it("renders inline math as MathML through the production pipeline", async () => {
    render("The cost is $x^2$ when x is large.");
    const math = await waitForMath("x^2");
    // A <math> element only appears once KaTeX itself has rendered it.
    expect(math.querySelector("math")).toBeTruthy();
  });

  it("renders display math as a block math node", async () => {
    render("Before.\n\n$$E = mc^2$$\n\nAfter.");
    const math = await waitForMath("E = mc^2");
    expect(math.querySelector("math")).toBeTruthy();
    expect((math as HTMLElement).style.display).toBe("block");
  });

  it("keeps HTML-looking tags inside a math span intact", async () => {
    render("Costs $x<y>z$ today");
    // Without the cleanup guard the tag is stripped and the label reads "xz".
    const math = await waitForMath("x<y>z");
    expect(math.querySelector("math")).toBeTruthy();
  });

  it("keeps prices as plain text", async () => {
    render("It costs $5 and $10, or $2,000 total.");
    await waitFor(() => expect(container.textContent).toContain("$5 and $10"));
    expect(view().queryAllByRole("math")).toEqual([]);
  });

  it("keeps dollar signs inside inline code literal", async () => {
    render("Set `a$b` and `$HOME` for the build.");
    await waitFor(() => expect(container.textContent).toContain("a$b"));
    expect(view().queryAllByRole("math")).toEqual([]);
  });
});
