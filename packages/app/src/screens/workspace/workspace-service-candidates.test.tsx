/**
 * @vitest-environment jsdom
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { i18n as testI18n } from "@/i18n/i18next";
import type { WorkspaceServicePayload } from "@getpaseo/protocol/messages";
import { beforeEach, expect, test, vi } from "vitest";
import { WorkspaceServiceCandidates } from "./workspace-service-candidates";

void testI18n;

const { confirmDialogMock, createTerminalMock, openServiceUrlMock } = vi.hoisted(() => ({
  confirmDialogMock: vi.fn(async () => true),
  createTerminalMock: vi.fn(async () => ({
    terminal: { id: "terminal-1" },
    error: null,
  })),
  openServiceUrlMock: vi.fn(),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (theme: unknown) => unknown) =>
      factory({
        spacing: { 2: 8, 6: 24 },
        borderRadius: { md: 6 },
        fontSize: { sm: 13 },
        fontWeight: { medium: "500" },
        colors: {
          foreground: "#fff",
          foregroundMuted: "#aaa",
          palette: { red: { 500: "#f00" } },
        },
      }),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({ uniProps: _uniProps, ...props }: Record<string, unknown>) => <Component {...props} />,
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: confirmDialogMock }));
vi.mock("@/utils/open-service-url", () => ({ openServiceUrl: openServiceUrlMock }));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ show: vi.fn() }),
}));

const packageService: WorkspaceServicePayload = {
  id: "package-dev",
  workspaceId: "workspace-1",
  source: "package",
  label: "dev",
  lifecycle: "available",
  terminalId: null,
  port: null,
  localUrl: null,
  publicUrl: null,
  command: "pnpm run dev",
  openWhenHealthy: false,
  observedAt: "2026-08-24T12:00:00.000Z",
};
const daemonClient = { createTerminal: createTerminalMock } as never;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  confirmDialogMock.mockClear();
  createTerminalMock.mockClear();
  openServiceUrlMock.mockClear();
});

test("confirms the exact inferred command before starting a supervised terminal", async () => {
  const onTerminalStarted = vi.fn();
  render(
    <WorkspaceServiceCandidates
      client={daemonClient}
      workspaceDirectory="/workspace"
      services={[packageService]}
      error={null}
      onRefresh={vi.fn(async () => undefined)}
      onTerminalStarted={onTerminalStarted}
    />,
  );

  fireEvent.click(screen.getByLabelText("Start dev"));
  await waitFor(() => expect(confirmDialogMock).toHaveBeenCalledOnce());
  expect(confirmDialogMock).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("pnpm run dev") }),
  );
  expect(createTerminalMock).toHaveBeenCalledWith("/workspace", "dev", undefined, {
    command: "pnpm",
    args: ["run", "dev"],
    workspaceId: "workspace-1",
  });
  expect(onTerminalStarted).toHaveBeenCalledWith("terminal-1");
});

test("opens a detected terminal URL in the Paseo browser", () => {
  render(
    <WorkspaceServiceCandidates
      client={null}
      workspaceDirectory="/workspace"
      services={[
        {
          ...packageService,
          id: "terminal-vite",
          source: "terminal",
          label: "localhost:5173",
          lifecycle: "healthy",
          terminalId: "terminal-vite",
          port: 5173,
          localUrl: "http://localhost:5173",
          command: null,
        },
      ]}
      error={null}
      onRefresh={vi.fn(async () => undefined)}
    />,
  );

  fireEvent.click(screen.getByLabelText("Open localhost:5173"));
  expect(openServiceUrlMock).toHaveBeenCalledWith("http://localhost:5173", {
    openInApp: undefined,
  });
});
