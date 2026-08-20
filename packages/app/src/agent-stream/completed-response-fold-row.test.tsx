/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8 },
    fontSize: { sm: 14 },
    colors: {
      foregroundMuted: "#muted",
      surface1: "#surface-1",
      surface2: "#surface-2",
    },
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "agentStream.completedResponse.showWork" ? "Show work" : "Hide work",
  }),
}));

vi.mock("react-native", () => ({
  Pressable: ({
    accessibilityLabel,
    accessibilityState,
    children,
    onPress,
    testID,
  }: React.PropsWithChildren<{
    accessibilityLabel: string;
    accessibilityState: { expanded: boolean };
    onPress: () => void;
    testID: string;
  }>) =>
    React.createElement(
      "button",
      {
        "aria-expanded": accessibilityState.expanded,
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        onClick: onPress,
        type: "button",
      },
      children,
    ),
  Text: ({ children }: React.PropsWithChildren) => React.createElement("span", null, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (value: typeof theme) => unknown) => factory(theme),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({ uniProps: _uniProps, ...props }: Record<string, unknown>) =>
      React.createElement(Component, props),
}));

vi.mock("lucide-react-native", () => ({
  ChevronDown: (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": "down" }),
  ChevronRight: (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": "right" }),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { CompletedResponseFoldRow } from "./completed-response-fold-row";

const COLLAPSED_FOLD = { responseId: "final", expanded: false } as const;

describe("CompletedResponseFoldRow", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the final answer visible while completed work is collapsed", () => {
    const onToggle = vi.fn();
    act(() => {
      root.render(
        <CompletedResponseFoldRow fold={COLLAPSED_FOLD} onToggle={onToggle}>
          <p>Complete final answer</p>
        </CompletedResponseFoldRow>,
      );
    });

    expect(container.textContent).toContain("Show work");
    expect(container.textContent).toContain("Complete final answer");
  });
});
