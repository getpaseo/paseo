// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAccountChangeDialog } from "./codex-account-change-dialog";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 2: 8, 4: 16 },
    fontSize: { base: 15 },
    iconSize: { md: 16 },
    colors: { foreground: "#fff", foregroundMuted: "#aaa" },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) => (props: Record<string, unknown>) =>
      React.createElement(Component, props),
}));

vi.mock("lucide-react-native", () => ({
  RefreshCw: () => React.createElement("span", { "data-testid": "refresh-icon" }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === "agentPanel.codexAccountChange.title") return "Codex account changed";
      if (key === "agentPanel.codexAccountChange.keepCurrent") return "Keep current session";
      if (key === "agentPanel.codexAccountChange.reload") return "Reload agent";
      if (key === "workspace.tabs.toasts.reloadingAgent") return "Reloading agent...";
      if (key === "agentPanel.codexAccountChange.message") {
        return `${values?.previousAccount} -> ${values?.nextAccount}`;
      }
      return key;
    },
  }),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    visible,
    header,
    children,
    onClose,
    testID,
  }: {
    visible: boolean;
    header: { title: string; leading?: ReactNode };
    children: ReactNode;
    onClose: () => void;
    testID?: string;
  }) =>
    visible ? (
      <section data-testid={testID}>
        {header.leading}
        <h1>{header.title}</h1>
        <button type="button" data-testid="dialog-close" onClick={onClose}>
          Close
        </button>
        {children}
      </section>
    ) : null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));

afterEach(cleanup);

const accountChange = {
  previousLabel: "old@example.com",
  nextLabel: "new@example.com",
  revision: 1,
  key: "change-1",
};

describe("CodexAccountChangeDialog", () => {
  it("uses the Paseo modal surface and shows both account labels", () => {
    const onKeepCurrentSession = vi.fn();
    const onReloadAgent = vi.fn();
    render(
      <CodexAccountChangeDialog
        accountChange={accountChange}
        visible
        isReloading={false}
        onKeepCurrentSession={onKeepCurrentSession}
        onReloadAgent={onReloadAgent}
      />,
    );

    expect(screen.getByTestId("codex-account-change-dialog")).toBeTruthy();
    expect(screen.getByText("Codex account changed")).toBeTruthy();
    expect(screen.getByText("old@example.com -> new@example.com")).toBeTruthy();

    fireEvent.click(screen.getByTestId("codex-account-change-keep"));
    fireEvent.click(screen.getByTestId("codex-account-change-reload"));
    expect(onKeepCurrentSession).toHaveBeenCalledTimes(1);
    expect(onReloadAgent).toHaveBeenCalledTimes(1);
  });

  it("locks the actions while reloading", () => {
    render(
      <CodexAccountChangeDialog
        accountChange={accountChange}
        visible
        isReloading
        onKeepCurrentSession={vi.fn()}
        onReloadAgent={vi.fn()}
      />,
    );

    expect((screen.getByTestId("codex-account-change-keep") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId("codex-account-change-reload") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Reloading agent...")).toBeTruthy();
  });
});
