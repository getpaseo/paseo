/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  usage: { contextWindowMaxTokens: 200000, contextWindowUsedTokens: 12345, totalCostUsd: 0.75 },
  refreshAgent: vi.fn(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ refreshAgent: fixture.refreshAgent }),
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: {
        host: {
          agents: new Map(),
          agentDetails: new Map([["archived", { lastUsage: fixture.usage }]]),
        },
      },
    }),
}));
vi.mock("@/components/context-window-meter", () => ({
  ContextWindowMeter: (props: object) => (
    <span data-testid="usage" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/constants/layout", () => ({ FOOTER_HEIGHT: 48 }));
vi.mock("@/keyboard/shift", () => ({
  KeyboardTranslateView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { ArchivedAgentCallout } from "./archived-agent-callout";

test("archived agents expose the native usage meter without unarchiving", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ArchivedAgentCallout serverId="host" agentId="archived" />));
    const meter = container.querySelector('[data-testid="usage"]');
    expect(JSON.parse(meter!.getAttribute("data-props")!)).toEqual({
      maxTokens: 200000,
      usedTokens: 12345,
      totalCostUsd: 0.75,
      showPercentage: true,
      serverId: "host",
      agentId: "archived",
    });
    expect(container.textContent).toContain("agentPanel.archived.callout");
    expect(fixture.refreshAgent).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
