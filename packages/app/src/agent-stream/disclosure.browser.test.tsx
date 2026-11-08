import React, { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { PlanCard } from "@/components/plan-card";
import { MessagePreview } from "@/components/user-message";
import { DisclosureRow } from "./disclosure";
import type { DisclosureTriggerEdge, StreamViewportHandle } from "./strategy";

// Load translations so the toggles expose their real accessible names.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

let root: Root;
let container: HTMLDivElement;
// The plan body renders through the app's Markdown renderer, which reads through React Query.
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient();
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
});

interface Hold {
  rowId: string;
  triggerEdge: DisclosureTriggerEdge;
  /** Whether the expanded content was already on screen when the strategy received the hold. */
  appliedBefore: boolean;
}

/**
 * A timeline row whose viewport records each hold. Like the strategies, it runs `apply` itself, so
 * a toggle that skips the hold still changes state but leaves no record.
 */
function mountRow(rowId: string, isApplied: () => boolean, children: ReactNode) {
  const holds: Hold[] = [];
  const viewport: StreamViewportHandle = {
    scrollToBottom: vi.fn(),
    prepareForViewportChange: vi.fn(),
    holdRow: (heldRowId, apply, triggerEdge) => {
      holds.push({ rowId: heldRowId, triggerEdge, appliedBefore: isApplied() });
      apply();
    },
  };
  const viewportRef = createRef<StreamViewportHandle>();
  viewportRef.current = viewport;
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <DisclosureRow rowId={rowId} viewportRef={viewportRef}>
          {children}
        </DisclosureRow>
      </QueryClientProvider>,
    ),
  );
  return holds;
}

const view = () => within(container);

const preLine = { whiteSpace: "pre-line" } as const;

async function waitForLayout() {
  await act(async () => {
    for (let frame = 0; frame < 2; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
}

describe("timeline disclosures hold their row", () => {
  it("routes user message show more and show less through the row's hold", async () => {
    const longText = Array.from({ length: 60 }, (_, line) => `Line ${line + 1}`).join("\n");
    const holds = mountRow(
      "message-1",
      () => view().queryByRole("button", { name: "Show less" }) !== null,
      <MessagePreview>
        <span style={preLine}>{longText}</span>
      </MessagePreview>,
    );
    // The preview learns it overflows from its first layout.
    await waitForLayout();

    act(() => view().getByRole("button", { name: "Show more" }).click());
    expect(view().getByRole("button", { name: "Show less" })).toBeTruthy();

    act(() => view().getByRole("button", { name: "Show less" }).click());
    expect(view().getByRole("button", { name: "Show more" })).toBeTruthy();

    expect(holds).toEqual([
      // Show more sits under the text it opens.
      { rowId: "message-1", triggerEdge: "bottom", appliedBefore: false },
      { rowId: "message-1", triggerEdge: "bottom", appliedBefore: true },
    ]);
  });

  it("routes plan card collapse and expand through the row's hold", () => {
    const header = () => view().getByRole("button", { name: "Approved plan" });
    const isExpanded = () => header().getAttribute("aria-expanded") === "true";
    const holds = mountRow(
      "plan-1",
      isExpanded,
      <PlanCard title="Plan" text="Step one" outcome="approved" />,
    );

    act(() => header().click());
    expect(isExpanded()).toBe(false);

    act(() => header().click());
    expect(isExpanded()).toBe(true);

    expect(holds).toEqual([
      { rowId: "plan-1", triggerEdge: "top", appliedBefore: true },
      { rowId: "plan-1", triggerEdge: "top", appliedBefore: false },
    ]);
  });

  it("toggles a plan card outside a timeline row, as the pending permission card renders", () => {
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <PlanCard title="Plan" text="Step one" outcome="pending" />
        </QueryClientProvider>,
      ),
    );
    const header = () => view().getByRole("button", { name: "Plan" });
    const isExpanded = () => header().getAttribute("aria-expanded") === "true";

    act(() => header().click());
    expect(isExpanded()).toBe(false);

    act(() => header().click());
    expect(isExpanded()).toBe(true);
  });
});
