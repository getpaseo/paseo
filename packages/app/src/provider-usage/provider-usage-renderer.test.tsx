/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16 },
    iconSize: { sm: 14, md: 18 },
    borderWidth: { 1: 1 },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 999 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    colors: {
      surface1: "#111",
      surface3: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      statusSuccess: "#16a34a",
      statusWarning: "#f59e0b",
      statusDanger: "#dc2626",
      palette: {
        red: { 300: "#fca5a5", 500: "#ef4444", 800: "#991b1b", 900: "#7f1d1d" },
        green: { 400: "#4ade80", 800: "#166534", 900: "#14532d" },
        white: "#fff",
      },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
    hairlineWidth: 1,
  },
  useUnistyles: () => ({ theme }),
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({ uniProps, ...props }: Record<string, unknown>) => {
      const mappedProps =
        typeof uniProps === "function" ? (uniProps as (t: typeof theme) => object)(theme) : {};
      return React.createElement(Component, { ...props, ...mappedProps });
    },
}));

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: () => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": "provider" }),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { ProviderUsageCard } from "./card";
import type { ProviderUsage } from "./types";

describe("ProviderUsageCard (generic renderer)", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
  });

  function render(usage: ProviderUsage) {
    act(() => {
      root?.render(<ProviderUsageCard usage={usage} />);
    });
  }

  it("renders display name, plan pill, and arbitrary window labels with percentages", () => {
    render({
      providerId: "claude",
      displayName: "Claude",
      status: "available",
      planLabel: "Max 20x",
      windows: [
        { id: "five_hour", label: "Session", usedPct: 42 },
        { id: "weekly", label: "Weekly", usedPct: 73 },
        // A window the renderer has never seen — proves no per-provider branching.
        { id: "biweekly", label: "Biweekly", usedPct: 12 },
      ],
    });

    const text = container?.textContent ?? "";
    expect(text).toContain("Claude");
    expect(text).toContain("Max 20x");
    expect(text).toContain("Session");
    expect(text).toContain("42%");
    expect(text).toContain("Weekly");
    expect(text).toContain("73%");
    expect(text).toContain("Biweekly");
    expect(text).toContain("12%");
  });

  it("renders an unknown provider with the same generic shape", () => {
    render({
      providerId: "brand-new-provider",
      displayName: "Brand New",
      status: "available",
      planLabel: "Pro",
      windows: [{ id: "daily", label: "Daily", remainingPct: 30 }],
    });

    const text = container?.textContent ?? "";
    expect(text).toContain("Brand New");
    expect(text).toContain("Daily");
    // remainingPct 30 -> used 70%
    expect(text).toContain("70%");
  });

  it("renders balances in each unit without provider-specific logic", () => {
    render({
      providerId: "codex",
      displayName: "Codex",
      status: "available",
      planLabel: null,
      windows: [],
      balances: [
        { id: "credits", label: "Credits", remaining: 1234, unit: "credits" },
        { id: "extra", label: "Extra usage", used: 5, limit: 20, unit: "usd" },
      ],
    });

    const text = container?.textContent ?? "";
    expect(text).toContain("Credits");
    expect(text).toContain("1,234 left");
    expect(text).toContain("Extra usage");
    expect(text).toContain("$5.00 / $20.00");
  });

  it("renders detail rows and source metadata", () => {
    render({
      providerId: "zai",
      displayName: "GLM coding plan",
      status: "available",
      planLabel: null,
      sourceLabel: "OpenUsage 0.6.27",
      windows: [],
      details: [{ id: "valid", label: "Valid until", value: "2026-12-31" }],
    });

    const text = container?.textContent ?? "";
    expect(text).toContain("GLM coding plan");
    expect(text).toContain("Valid until");
    expect(text).toContain("2026-12-31");
    expect(text).toContain("OpenUsage 0.6.27");
  });

  it("renders error status with the error message and still shows other data", () => {
    render({
      providerId: "grok",
      displayName: "Grok",
      status: "error",
      planLabel: null,
      error: "Token expired",
      windows: [{ id: "monthly", label: "Monthly", usedPct: 50 }],
    });

    const text = container?.textContent ?? "";
    expect(text).toContain("Error");
    expect(text).toContain("Token expired");
    expect(text).toContain("Monthly");
    expect(text).toContain("50%");
  });
});
