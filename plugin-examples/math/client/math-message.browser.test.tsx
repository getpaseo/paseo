import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MathMessage, mathMessageSchema } from "./math-message";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = {
  colors: { foreground: "rgb(230, 230, 230)" },
} as unknown as Parameters<typeof MathMessage>[0]["theme"];

const host = { id: "local", label: "Local" };
const layout = { compact: false, platform: "web" } as const;
const timestamp = new Date(0);

function Message({ segments }: { segments: unknown[] }) {
  const data = useMemo(() => mathMessageSchema.parse({ segments }), [segments]);
  const item = useMemo(
    () => ({ type: "plugin" as const, kind: "math-message", version: 1, data }),
    [data],
  );
  return (
    <MathMessage
      agentId="agent-1"
      item={item}
      timestamp={timestamp}
      theme={theme}
      host={host}
      layout={layout}
    />
  );
}

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mountMessage(segments: unknown[]): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Message segments={segments} />);
  });
  mounted.push({ root, container });
  return container;
}

function requireMath(container: HTMLDivElement): Element {
  const math = container.querySelector("math");
  if (math === null) throw new Error("the message did not render MathML");
  return math;
}

describe("math timeline renderer", () => {
  it("keeps an inline formula in the sentence flow", () => {
    const container = mountMessage([
      { kind: "text", text: "Hello " },
      { kind: "math", tex: "x^2", display: false },
      { kind: "text", text: " world" },
    ]);
    const math = requireMath(container);

    expect(container.textContent).toContain("Hello");
    expect(container.textContent).toContain("world");
    expect(math.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe("x^2");
    // One flowing line, not three stacked rows.
    const messageRect = container.getBoundingClientRect();
    const mathRect = math.getBoundingClientRect();
    expect(messageRect.height).toBeLessThan(48);
    expect(Math.abs(mathRect.top - messageRect.top)).toBeLessThan(24);
  });

  it("gives display math its own row", () => {
    const container = mountMessage([
      { kind: "text", text: "Budget" },
      { kind: "math", tex: "\\frac{a}{b}", display: true },
    ]);
    const math = requireMath(container);
    const rows = Array.from(container.firstElementChild?.children ?? []);
    const mathRect = math.getBoundingClientRect();

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(mathRect.top).toBeGreaterThanOrEqual(rows[0].getBoundingClientRect().bottom - 2);
  });

  it("uses the theme colour and falls back to the delimited source", () => {
    const container = mountMessage([{ kind: "math", tex: "\\frac{", display: false }]);

    expect(container.querySelector("math")).toBeNull();
    const matches = Array.from(container.querySelectorAll<HTMLElement>("span, div")).filter(
      (element) => element.textContent === "$\\frac{$",
    );
    const fallback = matches[matches.length - 1];
    expect(fallback).toBeDefined();
    expect(getComputedStyle(fallback).color).toBe("rgb(230, 230, 230)");
  });
});
