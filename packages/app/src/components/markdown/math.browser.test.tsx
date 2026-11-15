import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { findRenderedMatches } from "@/agent-stream/chat-find/ranges.web";
import { createAssistantSelectionClipboardContent } from "@/assistant-selection-copy/content.web";
import { MarkdownRenderer } from "./renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface MountedMarkdown {
  root: Root;
  container: HTMLDivElement;
  queryClient: QueryClient;
}

const mountedViews: MountedMarkdown[] = [];

async function mountMarkdown(text: string): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <div data-message-id="msg-math-1">
          <div data-testid="assistant-message" data-message-text="true">
            <MarkdownRenderer text={text} />
          </div>
        </div>
      </QueryClientProvider>,
    );
  });

  mountedViews.push({ root, container, queryClient });
  return container;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  expect(predicate()).toBe(true);
}

afterEach(() => {
  for (const mounted of mountedViews.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.queryClient.clear();
    mounted.container.remove();
  }
});

describe("MarkdownRenderer web MathML rendering", () => {
  it("renders inline and display LaTeX formulas as browser-native MathML while keeping currency literal", async () => {
    const markdown = [
      "The plan costs $20/mo ($50 to $100/yr), so for $(n + 1)$ users:",
      "",
      "只在 $2^k$ 翻倍点建 Key，当亲和阈值 $\\theta \\in [0.5, 1.0]$ 时，读区间 $[\\text{floorLevel}(\\theta N_w), N_w]$ 满足 $\\le 2$。",
      "",
      "$$",
      "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}",
      "$$",
    ].join("\n");

    const container = await mountMarkdown(markdown);
    await waitForCondition(() => container.querySelectorAll("math").length === 6);

    const mathNodes = [...container.querySelectorAll("math")];
    expect(mathNodes).toHaveLength(6);
    expect(mathNodes.at(-1)?.getAttribute("display")).toBe("block");
    expect(container.querySelector("mfrac")).not.toBeNull();
    expect(container.querySelector("msqrt")).not.toBeNull();
    expect(container.textContent).toContain("$20/mo ($50 to $100/yr)");
  });

  it("renders pure currency and shell prose with zero MathML elements", async () => {
    const container = await mountMarkdown(
      "Costs $50 to $100, $50-$100, From $10 to 20$, and shell $HOME / $?. Inline `$x + y$`.",
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(container.querySelectorAll("math")).toHaveLength(0);
    expect(container.querySelectorAll('[role="math"]')).toHaveLength(0);
    expect(container.textContent).toContain("Costs $50 to $100, $50-$100, From $10 to 20$");
  });

  it("ignores hidden MathML annotations in chat find and round-trips LaTeX in selection copy", async () => {
    const markdown = [
      "只在 $2^k$ 翻倍点建 Key，读区间 $[\\text{floorLevel}(\\theta N_w), N_w]$。",
      "",
      "$$",
      "x^2 + y^2 = z^2",
      "$$",
    ].join("\n");

    const container = await mountMarkdown(markdown);
    await waitForCondition(() => container.querySelectorAll("math").length === 3);

    const row = container.querySelector<HTMLElement>('[data-message-id="msg-math-1"]')!;
    const assistantMessage = container.querySelector<HTMLElement>(
      '[data-testid="assistant-message"]',
    )!;

    const matches = findRenderedMatches(row, "floorLevel");
    expect(matches).toHaveLength(1);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(assistantMessage);
    selection?.addRange(range);

    const copied = createAssistantSelectionClipboardContent(selection);
    expect(copied?.plainText).toContain("$2^k$");
    expect(copied?.plainText).toContain("$[\\text{floorLevel}(\\theta N_w), N_w]$");
    expect(copied?.plainText).toContain("$$\nx^2 + y^2 = z^2\n$$");
    selection?.removeAllRanges();
  });
});
