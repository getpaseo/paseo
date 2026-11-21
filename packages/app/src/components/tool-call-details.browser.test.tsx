import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { i18n as testI18n } from "@/i18n/i18next";
import { ToolCallDetailsContent } from "./tool-call-details";

void testI18n;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

const mounted: Mounted[] = [];

beforeEach(() => vi.stubGlobal("React", React));

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  vi.unstubAllGlobals();
});

function mountDetails(detail: ToolCallDetail): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = "320px";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ToolCallDetailsContent detail={detail} maxHeight={200} />));
  mounted.push({ container, root });
  return container;
}

describe("ToolCallDetailsContent shell working directory", () => {
  it("shows the exact long cwd while preserving the command and output", () => {
    const cwd = `\\\\?\\C:\\Workspaces\\Personal AI\\${Array.from(
      { length: 10 },
      (_, index) => `nested-directory-${index}-with-a-long-name`,
    ).join("\\")}\\fixture `;
    const container = mountDetails({
      type: "shell",
      command: "python -m unittest",
      cwd,
      output: "Ran 1 test",
    });

    const rendered = container.textContent ?? "";
    expect(rendered).toContain(`cwd: ${cwd}`);
    expect(rendered).toContain("$ python -m unittest");
    expect(rendered).toContain("Ran 1 test");

    const scrollArea = container.querySelector<HTMLElement>(
      '[data-testid="shell-detail-working-directory"]',
    );
    if (!scrollArea) throw new Error("Expected the cwd detail scroll area to be rendered");
    expect(scrollArea.clientWidth).toBeLessThanOrEqual(320);
    expect(scrollArea.scrollWidth).toBeGreaterThan(scrollArea.clientWidth);
    scrollArea.scrollLeft = scrollArea.scrollWidth;
    expect(scrollArea.scrollLeft).toBeGreaterThan(0);
  });

  it.each([undefined, "", " \t\n"])("omits absent or blank cwd without guessing", (cwd) => {
    const detail: ToolCallDetail = {
      type: "shell",
      command: "pwd",
      ...(typeof cwd === "string" ? { cwd } : {}),
      output: "done",
    };
    const rendered = mountDetails(detail).textContent ?? "";

    expect(rendered).not.toContain("cwd:");
    expect(rendered).toContain("$ pwd");
    expect(rendered).toContain("done");
  });

  it("leaves non-shell details unchanged", () => {
    const container = mountDetails({
      type: "unknown",
      input: { message: "existing detail" },
      output: null,
    });
    const rendered = container.textContent ?? "";

    expect(rendered).not.toContain("cwd:");
    expect(rendered).toContain("existing detail");
  });
});
