import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MathFormula } from "./math-formula.web";

afterEach(cleanup);

describe("MathFormula", () => {
  it("renders an accessible KaTeX formula", () => {
    const { container } = render(
      <MathFormula expression="E = mc^2" source="$E = mc^2$" displayMode={false} />,
    );

    expect(container.querySelector(".katex-html")?.textContent).toContain("E=mc2");
    expect(container.querySelector("math")?.getAttribute("aria-hidden")).not.toBe("true");
    expect(container.querySelector("[aria-label='$E = mc^2$']")).not.toBeNull();
  });

  it("keeps inline fractions compact and structurally rendered", () => {
    const expression = String.raw`\displaystyle x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`;
    const { container } = render(
      <MathFormula expression={expression} source={`$${expression}$`} displayMode={false} />,
    );

    const formula = container.querySelector<HTMLElement>("[aria-label]");
    expect(formula?.style.fontSize).toBe("0.9em");
    expect(formula?.style.verticalAlign).toBe("baseline");
    expect(container.querySelector("math")?.getAttribute("display")).not.toBe("block");
    expect(container.querySelector("mfrac")).not.toBeNull();
    expect(container.querySelector("annotation")?.textContent).not.toContain("\\displaystyle");
    expect(container.querySelector(".frac-line")).not.toBeNull();
  });

  it("keeps invalid LaTeX visible instead of throwing", () => {
    const { container } = render(
      <MathFormula expression="\\notacommand{" source="\\[\\notacommand{\\]" displayMode />,
    );

    expect(container.textContent).toContain("\\notacommand{");
  });
});
