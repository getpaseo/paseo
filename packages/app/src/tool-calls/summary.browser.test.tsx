import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { ToolCallSummaryLabel } from "./summary-label";
import { Pressable } from "react-native";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolCallDetailsContent } from "@/components/tool-call-details";

const detail: ToolCallDetail = {
  type: "shell",
  command: "npm run typecheck",
  output: "TS2339: Property foo does not exist",
};

let mounted: { root: Root; container: HTMLDivElement } | null = null;
afterEach(() => {
  if (!mounted) return;
  act(() => mounted?.root.unmount());
  mounted.container.remove();
  mounted = null;
});

describe("generated tool-call details", () => {
  it.each([360, 1000])(
    "shows the full description and original command/output at %ipx",
    (width) => {
      const container = document.createElement("div");
      container.style.width = `${width}px`;
      document.body.appendChild(container);
      const root = createRoot(container);
      mounted = { root, container };
      const description =
        "Checked the app's types. The check failed because a required property was missing. The command made no changes.";
      act(() =>
        root.render(
          <ToolCallDetailsContent
            description={description}
            detail={detail}
            errorText="Exit code 1"
          />,
        ),
      );
      const summary = container.querySelector('[data-testid="tool-call-description"]');
      expect(summary?.textContent).toBe(description);
      expect(container.textContent).toContain("npm run typecheck");
      expect(container.textContent).toContain("TS2339");
      expect(container.textContent).toContain("Exit code 1");
      expect(summary?.getBoundingClientRect().width).toBeLessThanOrEqual(width);
    },
  );
});

describe("input and result labels", () => {
  it.each([360, 1000])("keeps linked input and result on one line at %ipx", (width) => {
    const container = document.createElement("div");
    container.style.width = `${width}px`;
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };
    const openFile = vi.fn();
    const expand = vi.fn();
    const render = (output?: string) =>
      act(() =>
        root.render(
          <Pressable onPress={expand}>
            <ToolCallSummaryLabel
              input="Read lets-plan-adding-it-federated-cerf.md"
              output={output}
              inputFilePath="/Users/me/.claude/plans/lets-plan-adding-it-federated-cerf.md"
              onOpenFilePath={openFile}
              outputFilePath="/repo/src/keep-awake.ts"
            />
          </Pressable>,
        ),
      );
    render();
    expect(container.textContent).toBe("Read lets-plan-adding-it-federated-cerf.md");
    expect(container.querySelector('[data-testid="tool-call-output-label"]')).toBeNull();
    render("Plan: prevent Mac sleep during agent runs");
    const input = container.querySelector<HTMLElement>('[data-testid="tool-call-input-label"]')!;
    const output = container.querySelector<HTMLElement>('[data-testid="tool-call-output-label"]')!;
    const link = container.querySelector<HTMLElement>('[role="link"]')!;
    expect(getComputedStyle(input).fontWeight).toBe("500");
    expect(getComputedStyle(output).fontWeight).toBe("400");
    expect(getComputedStyle(link).fontWeight).toBe("500");
    expect(input.getBoundingClientRect().top).toBe(output.getBoundingClientRect().top);
    expect(output.getBoundingClientRect().right).toBeLessThanOrEqual(
      container.getBoundingClientRect().right,
    );
    expect(container.textContent).toContain("→Plan: prevent Mac sleep during agent runs");
    act(() => link.click());
    expect(openFile).toHaveBeenCalledOnce();
    expect(expand).not.toHaveBeenCalled();
    expect(openFile).toHaveBeenLastCalledWith(
      "/Users/me/.claude/plans/lets-plan-adding-it-federated-cerf.md",
    );
    render("Updated keep-awake.ts");
    const outputLink = container.querySelector<HTMLElement>(
      '[data-testid="tool-call-output-label"] [role="link"]',
    )!;
    act(() => outputLink.click());
    expect(openFile).toHaveBeenLastCalledWith("/repo/src/keep-awake.ts");
    expect(expand).not.toHaveBeenCalled();
  });
});
