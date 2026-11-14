import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { ToastApiProvider } from "@/contexts/toast-context";
import type { ToastApi } from "@/components/toast-host";
import type { PrPaneCheck, PrPaneData } from "./data";
import { PullRequestPane } from "./pane";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const PANE_HEIGHT = 600;

const silentToasts: ToastApi = {
  show: () => () => {},
  copied: () => {},
  error: () => {},
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function successfulChecks(count: number): PrPaneCheck[] {
  return Array.from({ length: count }, (_, index) => ({
    provider: "github",
    name: `check-${index + 1}`,
    status: "success",
    url: `https://example.test/checks/${index + 1}`,
  }));
}

function pullRequest(checks: PrPaneCheck[]): PrPaneData {
  return {
    provider: { id: "github", label: "GitHub" },
    forge: "github",
    number: 42,
    repoOwner: "acme",
    repoName: "widgets",
    title: "Ship the widget",
    state: "open",
    url: "https://example.test/pull/42",
    reviewDecision: "pending",
    awaitingReviewers: [],
    checks,
    activity: [],
  };
}

/** A phone's home indicator: the pane clears it with bottom padding. */
const HOME_INDICATOR_INSETS = { top: 0, right: 0, bottom: 34, left: 0 };

function mountPane(data: PrPaneData, insets = { top: 0, right: 0, bottom: 0, left: 0 }) {
  container = document.createElement("div");
  container.style.height = `${PANE_HEIGHT}px`;
  container.style.width = "600px";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <SafeAreaInsetsContext.Provider value={insets}>
        <ToastApiProvider api={silentToasts}>
          <PullRequestPane serverId="server-1" cwd="/repo" data={data} activityLoading={false} />
        </ToastApiProvider>
      </SafeAreaInsetsContext.Provider>,
    ),
  );
  const pane = container.querySelector<HTMLElement>('[data-testid="pr-pane"]');
  if (!pane) throw new Error("The pull request pane did not render");
  return pane;
}

/** The pressable row holding the Activity title. */
function activityHeader(pane: HTMLElement): HTMLElement {
  const title = within(pane).getByText(i18n.t("workspace.git.pr.sections.activity"));
  const header = title.closest<HTMLElement>("[tabindex]");
  if (!header) throw new Error("The Activity title is not inside a pressable header");
  return header;
}

function checksRegionBottom(pane: HTMLElement): number {
  return within(pane).getByRole("separator").getBoundingClientRect().top;
}

/** Whether a user sees the element: no scroll container clips it out of view. */
function isOnScreen(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + 8, rect.top + rect.height / 2);
  return hit !== null && element.contains(hit);
}

/** React Native Web reports layout from a ResizeObserver, a frame or two after mounting. */
async function settleLayout() {
  for (let frame = 0; frame < 2; frame++) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

function dragSeparator(pane: HTMLElement, deltaY: number) {
  const separator = within(pane).getByRole("separator");
  const rect = separator.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;
  const pointer = { pointerId: 1, bubbles: true, cancelable: true, clientX: x, button: 0 };
  act(() => {
    separator.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientY: startY }));
  });
  act(() => {
    window.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientY: startY + deltaY }));
  });
  act(() => {
    window.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientY: startY + deltaY }));
  });
}

describe("pull request pane layout", () => {
  it("docks a collapsed Activity section to the bottom and gives the checks the pane", async () => {
    const pane = mountPane(pullRequest(successfulChecks(10)));

    act(() => activityHeader(pane).click());

    await expect
      .poll(() => Math.round(activityHeader(pane).getBoundingClientRect().bottom))
      .toBe(Math.round(pane.getBoundingClientRect().bottom));
    const rows = within(pane).getAllByTestId("pr-pane-check-row");
    expect(rows).toHaveLength(10);
    expect(rows.every(isOnScreen)).toBe(true);
  });

  it("resizes the checks against Activity by dragging the separator between them", async () => {
    const pane = mountPane(pullRequest(successfulChecks(30)));
    await settleLayout();
    const before = checksRegionBottom(pane);

    dragSeparator(pane, 120);

    await expect.poll(() => Math.round(checksRegionBottom(pane) - before)).toBe(120);
    expect(activityHeader(pane).getBoundingClientRect().top).toBeGreaterThan(before + 100);
  });

  it("keeps the separator under the pointer when the pane clears a bottom inset", async () => {
    const pane = mountPane(pullRequest(successfulChecks(30)), HOME_INDICATOR_INSETS);
    await settleLayout();
    const before = checksRegionBottom(pane);

    dragSeparator(pane, 120);

    await expect.poll(() => Math.round(checksRegionBottom(pane) - before)).toBe(120);
  });
});
