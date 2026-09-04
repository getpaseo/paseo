import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBadge } from "./status-badge";

interface MountedBadge {
  root: Root;
  container: HTMLDivElement;
}

const mountedBadges: MountedBadge[] = [];

function mountBadge(variant: "success" | "warning" | "error" | "muted"): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => root.render(<StatusBadge label="Status" variant={variant} />));
  mountedBadges.push({ root, container });

  const badge = container.firstElementChild;
  if (!(badge instanceof HTMLElement)) {
    throw new Error("StatusBadge did not render a badge element");
  }
  return badge;
}

afterEach(() => {
  for (const mounted of mountedBadges.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("StatusBadge", () => {
  it.each(["success", "warning", "error", "muted"] as const)(
    "uses the semantic badge shell for the %s variant",
    (variant) => {
      const badge = mountBadge(variant);
      const style = getComputedStyle(badge);

      expect(style.backgroundColor).toBe("rgb(228, 228, 231)");
      expect(style.borderColor).toBe("rgb(228, 228, 231)");
    },
  );

  it.each([
    ["success", "rgb(21, 128, 61)"],
    ["warning", "rgb(217, 119, 6)"],
    ["error", "rgb(185, 28, 28)"],
    ["muted", "rgb(102, 102, 102)"],
  ] as const)("uses the semantic %s signal for its text", (variant, expectedColor) => {
    const badge = mountBadge(variant);
    const text = badge.lastElementChild;
    if (!(text instanceof HTMLElement)) {
      throw new Error("StatusBadge did not render its label");
    }

    expect(getComputedStyle(text).color).toBe(expectedColor);
  });
});
