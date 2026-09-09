import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderUsageCard } from "./card";
import type { ProviderUsage } from "./types";

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: () => () => null,
}));

vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: () => null,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  withUnistyles: (Component: React.ComponentType) => Component,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const usage: ProviderUsage = {
  providerId: "claude",
  displayName: "Claude",
  status: "available",
  planLabel: null,
  windows: [],
  balances: [],
  details: [],
  fetchedAt: "2026-09-09T12:00:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T12:01:00.000Z"));
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ProviderUsageCard", () => {
  it("updates its mounted relative-time footer on the shared minute tick", () => {
    act(() => root?.render(<ProviderUsageCard usage={usage} />));
    expect(container?.textContent).toContain("Updated 1m ago");

    act(() => vi.advanceTimersByTime(60_000));
    expect(container?.textContent).toContain("Updated 2m ago");
  });
});
