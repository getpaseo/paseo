import React, { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { PlanCard } from "@/components/plan-card";
import { MessagePreview } from "@/components/user-message";
import { DisclosureRow } from "./disclosure";
import type { StreamViewportHandle } from "./strategy";

// Load translations so the toggles expose their real accessible names.
void testI18n;

// The Markdown engine does not load in this harness; the plan body only needs to be present.
vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: ({ text }: { text: string }) => <span>{text}</span>,
}));

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

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

interface Hold {
  rowId: string;
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
    holdRow: (heldRowId, apply) => {
      holds.push({ rowId: heldRowId, appliedBefore: isApplied() });
      apply();
    },
  };
  const viewportRef = createRef<StreamViewportHandle>();
  viewportRef.current = viewport;
  act(() =>
    root.render(
      <DisclosureRow rowId={rowId} viewportRef={viewportRef}>
        {children}
      </DisclosureRow>,
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
      { rowId: "message-1", appliedBefore: false },
      { rowId: "message-1", appliedBefore: true },
    ]);
  });

  it("routes plan card collapse and expand through the row's hold", () => {
    const holds = mountRow(
      "plan-1",
      () => view().queryByText("Step one") !== null,
      <PlanCard title="Plan" text="Step one" outcome="approved" />,
    );
    const header = () => view().getByRole("button", { name: "Approved plan" });

    act(() => header().click());
    expect(view().queryByText("Step one")).toBeNull();

    act(() => header().click());
    expect(view().getByText("Step one")).toBeTruthy();

    expect(holds).toEqual([
      { rowId: "plan-1", appliedBefore: true },
      { rowId: "plan-1", appliedBefore: false },
    ]);
  });

  it("toggles a plan card outside a timeline row, as the pending permission card renders", () => {
    act(() => root.render(<PlanCard title="Plan" text="Step one" outcome="pending" />));
    const header = () => view().getByRole("button", { name: "Plan" });

    act(() => header().click());
    expect(view().queryByText("Step one")).toBeNull();

    act(() => header().click());
    expect(view().getByText("Step one")).toBeTruthy();
  });
});
