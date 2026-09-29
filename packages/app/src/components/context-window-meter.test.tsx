/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6 },
    borderRadius: { full: 999 },
    fontSize: { xs: 11, sm: 13, base: 14 },
    fontWeight: { normal: "400" },
    colors: {
      surface3: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      foregroundExtraMuted: "#777",
      destructive: "#f44",
      palette: { amber: { 500: "#fa0" } },
    },
  },
}));

vi.mock("react-native", () => ({
  View: ({ children, testID, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("div", { ...props, "data-testid": testID }, children),
  Text: ({ children, testID, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("span", { ...props, "data-testid": testID }, children),
  Pressable: ({ children, testID, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", { ...props, type: "button", "data-testid": testID }, children),
}));

vi.mock("react-native-svg", () => ({
  default: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("svg", props, children),
  Circle: (props: Record<string, unknown>) => React.createElement("circle", props),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (value: typeof theme) => unknown) => factory(theme),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        "contextWindow.accessibility": "Context window {{percentage}}% used",
        "contextWindow.loading": "Context window loading",
        "contextWindow.sessionCost": "Session cost {{cost}}",
        "contextWindow.snapshot": "Usage snapshot",
        "contextWindow.title": "Context window",
        "contextWindow.tokens": "{{used}} / {{max}} tokens",
        "contextWindow.unknown": "Context unknown",
        "contextWindow.unknownAccessibility": "Context window usage unknown",
        "contextWindow.used": "{{percentage}}% used",
      };
      return Object.entries(values ?? {}).reduce(
        (message, [name, value]) => message.replace(`{{${name}}}`, String(value)),
        messages[key] ?? key,
      );
    },
  }),
}));

vi.mock("@/components/ui/tooltip", async () => {
  const ReactModule = await import("react");
  const TooltipContext = ReactModule.createContext(false);
  return {
    Tooltip: ({ children }: React.PropsWithChildren) => {
      const [open, setOpen] = ReactModule.useState(false);
      return ReactModule.createElement(
        TooltipContext.Provider,
        { value: open },
        ReactModule.createElement(
          "div",
          { onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false) },
          children,
        ),
      );
    },
    TooltipTrigger: ({ children }: React.PropsWithChildren) => children,
    TooltipContent: ({ children }: React.PropsWithChildren) =>
      ReactModule.useContext(TooltipContext)
        ? ReactModule.createElement("div", { role: "tooltip" }, children)
        : null,
  };
});

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { ContextWindowMeter } from "./context-window-meter";

describe("ContextWindowMeter", () => {
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

  it("keeps the validated used/max pair and idle snapshot cue visible without hover", () => {
    act(() => root.render(<ContextWindowMeter maxTokens={380_000} usedTokens={81_000} />));

    expect(
      container.querySelector('[data-testid="context-window-meter-summary"]')?.textContent,
    ).toBe("81k / 380k tokens");
    expect(
      container.querySelector('[data-testid="context-window-meter-snapshot-cue"]')?.textContent,
    ).toBe("Usage snapshot");
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("opens the existing detail tooltip on hover", async () => {
    act(() => root.render(<ContextWindowMeter maxTokens={380_000} usedTokens={81_000} />));

    await act(async () => {
      container.firstElementChild?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("21% used");
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("81k / 380k tokens");
  });

  it("keeps active retained values qualified as a snapshot", () => {
    act(() => root.render(<ContextWindowMeter maxTokens={380_000} usedTokens={81_000} pending />));

    expect(
      container.querySelector('[data-testid="context-window-meter-snapshot-cue"]')?.textContent,
    ).toBe("Usage snapshot");
  });

  it("shows loading and unknown states without fabricating a percentage", () => {
    act(() => root.render(<ContextWindowMeter maxTokens={null} usedTokens={null} pending />));
    expect(container.querySelector('[data-testid="context-window-meter-loading"]')).not.toBeNull();
    expect(container.textContent).not.toContain("%");

    act(() => root.render(<ContextWindowMeter maxTokens={Number.NaN} usedTokens={47_000} />));
    expect(
      container.querySelector('[data-testid="context-window-meter-unknown"]')?.textContent,
    ).toBe("Context unknown");
    expect(container.textContent).not.toContain("%");
  });

  it("replaces the selected session summary instead of retaining the prior values", () => {
    act(() => root.render(<ContextWindowMeter maxTokens={380_000} usedTokens={81_000} />));
    expect(container.textContent).toContain("81k / 380k tokens");

    act(() => root.render(<ContextWindowMeter maxTokens={128_000} usedTokens={2_000} />));
    expect(container.textContent).toContain("2k / 128k tokens");
    expect(container.textContent).not.toContain("81k / 380k tokens");
  });
});
