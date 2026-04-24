/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
    iconSize: { sm: 14, md: 18 },
    borderWidth: { 1: 1 },
    borderRadius: { sm: 4, md: 6, lg: 8, xl: 12, "2xl": 16, full: 999 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    opacity: { 50: 0.5 },
    shadow: { md: {} },
    colors: {
      surfaceSidebar: "#111",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      borderAccent: "#666",
      accent: "#0a84ff",
      accentForeground: "#fff",
      destructive: "#ff4444",
      primary: "#0a84ff",
      palette: { white: "#fff" },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    X: createIcon("X"),
    CheckCircle2: createIcon("CheckCircle2"),
    AlertTriangle: createIcon("AlertTriangle"),
  };
});

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { CalloutCard } from "./callout-card";

type CalloutCardActions = React.ComponentProps<typeof CalloutCard>["actions"];

function buildSingleAction(onPress: () => void): CalloutCardActions {
  return [{ label: "Undo", onPress }];
}

function buildTwoActions(onWhatsNew: () => void, onInstall: () => void): CalloutCardActions {
  return [
    { label: "What's new", onPress: onWhatsNew },
    { label: "Install & restart", onPress: onInstall, variant: "primary" },
  ];
}

const calloutTitleIcon = <span data-testid="callout-title-icon" />;

describe("CalloutCard", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("renders title and description", () => {
    act(() => {
      root?.render(
        <CalloutCard title="Update available" description="v1.2.3 is ready to install." />,
      );
    });

    expect(container?.textContent).toContain("Update available");
    expect(container?.textContent).toContain("v1.2.3 is ready to install.");
  });

  it("renders an icon next to the title", () => {
    act(() => {
      root?.render(<CalloutCard title="Update available" icon={calloutTitleIcon} />);
    });

    expect(container?.querySelector('[data-testid="callout-title-icon"]')).not.toBeNull();
  });

  it("renders one action when one is provided", () => {
    const onPress = vi.fn();
    const actions = buildSingleAction(onPress);
    act(() => {
      root?.render(<CalloutCard description="Saved." actions={actions} testID="callout" />);
    });

    const button = container?.querySelector(
      '[data-testid="callout-action-0"]',
    ) as HTMLElement | null;
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("Undo");
  });

  it("renders up to two actions", () => {
    const actions = buildTwoActions(vi.fn(), vi.fn());
    act(() => {
      root?.render(
        <CalloutCard
          title="Update available"
          description="v1 ready."
          actions={actions}
          testID="callout"
        />,
      );
    });

    expect(container?.querySelector('[data-testid="callout-action-0"]')?.textContent).toContain(
      "What's new",
    );
    expect(container?.querySelector('[data-testid="callout-action-1"]')?.textContent).toContain(
      "Install & restart",
    );
  });

  it("renders no action row when no actions are provided", () => {
    act(() => {
      root?.render(<CalloutCard description="Copied" testID="callout" />);
    });

    expect(container?.querySelector('[data-testid="callout-actions"]')).toBeNull();
  });

  it("renders the dismiss X in the top-left when onDismiss is provided", () => {
    const onDismiss = vi.fn();
    act(() => {
      root?.render(<CalloutCard description="Saved" onDismiss={onDismiss} testID="callout" />);
    });

    const dismissButton = container?.querySelector(
      '[data-testid="callout-dismiss"]',
    ) as HTMLElement | null;
    expect(dismissButton).not.toBeNull();
  });

  it("omits the dismiss button when onDismiss is not provided", () => {
    act(() => {
      root?.render(<CalloutCard description="Saved" testID="callout" />);
    });

    expect(container?.querySelector('[data-testid="callout-dismiss"]')).toBeNull();
  });
});
