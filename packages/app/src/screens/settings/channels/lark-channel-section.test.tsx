/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LarkChannelBotStatus, LarkChannelStatus } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LarkChannelSection } from "./lark-channel-section";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    borderRadius: { md: 6, lg: 8, full: 9999 },
    borderWidth: { 1: 1 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontFamily: { mono: "monospace" },
    fontWeight: { normal: "400", medium: "500" },
    opacity: { 50: 0.5 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      border: "#444",
      borderAccent: "#555",
      accent: "#0a0",
      accentForeground: "#fff",
      destructive: "#a00",
      destructiveForeground: "#fff",
      statusSuccess: "#0f0",
      statusWarning: "#ff0",
      statusDanger: "#f00",
    },
  },
}));

const channelState = vi.hoisted(() => ({
  current: {
    status: null as LarkChannelStatus | null,
    configure: vi.fn(),
    deleteBot: vi.fn(),
    testConnection: vi.fn(),
    setEnabled: vi.fn(),
    approvePairing: vi.fn(),
    rejectPairing: vi.fn(),
    revokeUser: vi.fn(),
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: { uniProps?: (theme: unknown) => Record<string, unknown> } & Record<string, unknown>) => {
      const themed = uniProps ? uniProps(theme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("lucide-react-native", () => ({
  Bot: () => <span data-testid="bot-icon" />,
  ExternalLink: () => <span data-testid="external-link-icon" />,
}));

vi.mock("./use-lark-channel", () => ({
  useLarkChannel: () => ({
    status: channelState.current.status,
    isLoading: false,
    isConnected: true,
    error: null,
    configure: channelState.current.configure,
    deleteBot: channelState.current.deleteBot,
    testConnection: channelState.current.testConnection,
    setEnabled: channelState.current.setEnabled,
    approvePairing: channelState.current.approvePairing,
    rejectPairing: channelState.current.rejectPairing,
    revokeUser: channelState.current.revokeUser,
    isMutating: false,
    mutationError: null,
  }),
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => true,
}));

vi.mock("@/hooks/use-assistants", () => ({
  useAssistants: () => ({
    assistants: [{ id: "assistant-1", name: "Settlement", description: "Settlement helper" }],
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: [
      {
        provider: "claude",
        label: "Claude",
        enabled: true,
        models: [{ id: "sonnet", label: "Sonnet", description: "Sonnet" }],
      },
    ],
    isLoading: false,
    isFetching: false,
  }),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({
    projects: [
      {
        projectKey: "project-1",
        projectName: "Repo",
        projectCustomName: null,
        hosts: [{ serverId: "server-1", isOnline: true, repoRoot: "/repo/app" }],
      },
    ],
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/form-field", () => ({
  Field: ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
    <label>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  ),
  FormTextInput: ({
    initialValue,
    placeholder,
    resetKey,
    onChangeText,
  }: {
    initialValue?: string;
    placeholder?: string;
    resetKey?: string | number;
    onChangeText: (value: string) => void;
  }) => {
    const [value, setValue] = React.useState(initialValue ?? "");
    React.useEffect(() => {
      setValue(initialValue ?? "");
    }, [initialValue, resetKey]);
    return React.createElement("input", {
      value,
      placeholder,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        setValue(event.currentTarget.value);
        onChangeText(event.currentTarget.value);
      },
    });
  },
}));

vi.mock("@/components/ui/select-field", () => ({
  SelectField: ({
    label,
    selectedDisplay,
  }: {
    label: string;
    selectedDisplay?: { label: string } | null;
  }) => (
    <div>
      <span>{label}</span>
      <span>{selectedDisplay?.label ?? ""}</span>
    </div>
  ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    disabled,
  }: {
    value: boolean;
    onValueChange: (value: boolean) => void;
    disabled?: boolean;
  }) =>
    React.createElement("input", {
      type: "checkbox",
      checked: value,
      disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onValueChange(event.currentTarget.checked),
    }),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => <span>Loading</span>,
}));

vi.mock("@/screens/settings/settings-section", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

function makeBot(overrides: Partial<LarkChannelBotStatus> = {}): LarkChannelBotStatus {
  return {
    id: "bot-1",
    name: "Settlement bot",
    enabled: false,
    connectionStatus: "disabled",
    error: null,
    appId: "cli_settle",
    hasAppSecret: true,
    hasEncryptKey: false,
    hasVerificationToken: false,
    domain: "feishu",
    target: {
      kind: "assistant",
      assistantId: "assistant-1",
      provider: "claude",
      model: "sonnet",
      cwd: "/repo/app",
      workspaceId: null,
    },
    bot: null,
    pendingPairings: [],
    authorizedUsers: [],
    ...overrides,
  };
}

function makeStatus(
  bots: LarkChannelBotStatus[],
  activeBotId: string | null = bots[0]?.id ?? null,
): LarkChannelStatus {
  const active = bots.find((bot) => bot.id === activeBotId) ?? bots[0] ?? makeBot();
  return {
    enabled: active.enabled,
    connectionStatus: active.connectionStatus,
    error: active.error,
    appId: active.appId,
    hasAppSecret: active.hasAppSecret,
    hasEncryptKey: active.hasEncryptKey,
    hasVerificationToken: active.hasVerificationToken,
    domain: active.domain,
    target: active.target,
    bot: active.bot,
    pendingPairings: active.pendingPairings,
    authorizedUsers: active.authorizedUsers,
    activeBotId,
    bots,
  };
}

describe("LarkChannelSection", () => {
  afterEach(() => {
    cleanup();
    channelState.current.status = null;
    channelState.current.configure.mockReset();
    channelState.current.deleteBot.mockReset();
    channelState.current.testConnection.mockReset();
    channelState.current.setEnabled.mockReset();
    channelState.current.approvePairing.mockReset();
    channelState.current.rejectPairing.mockReset();
    channelState.current.revokeUser.mockReset();
  });

  test("shows multiple configured Lark bots and loads the selected bot", async () => {
    channelState.current.status = makeStatus([
      makeBot(),
      makeBot({ id: "bot-2", name: "Ops bot", appId: "cli_ops" }),
    ]);

    render(<LarkChannelSection serverId="server-1" />);

    expect(screen.getByText("Settlement bot")).toBeTruthy();
    expect(screen.getByText("Ops bot")).toBeTruthy();
    expect(screen.getByDisplayValue("cli_settle")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => expect(screen.getByDisplayValue("cli_ops")).toBeTruthy());
  });

  test("shows legacy single-bot status as a bot list item", async () => {
    channelState.current.status = {
      ...makeStatus([], null),
      enabled: true,
      connectionStatus: "connected",
      appId: "cli_legacy",
      hasAppSecret: true,
      target: {
        kind: "assistant",
        assistantId: "assistant-1",
        provider: "claude",
        model: "sonnet",
        cwd: "/repo/app",
        workspaceId: null,
      },
      bots: [],
      activeBotId: null,
    };

    render(<LarkChannelSection serverId="server-1" />);

    expect(screen.getByText("飞书机器人列表（1）")).toBeTruthy();
    expect(screen.getAllByText(/cli_legacy/).length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue("cli_legacy")).toBeTruthy();
  });

  test("adds and deletes Lark bots through channel mutations", async () => {
    const existingBot = makeBot();
    const newBot = makeBot({ id: "bot-2", name: "New bot", appId: "cli_new" });
    channelState.current.status = makeStatus([existingBot]);
    channelState.current.configure.mockResolvedValue(makeStatus([existingBot, newBot], newBot.id));
    channelState.current.deleteBot.mockResolvedValue(makeStatus([], null));

    render(<LarkChannelSection serverId="server-1" />);

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.change(screen.getByLabelText("机器人名称"), { target: { value: "New bot" } });
    fireEvent.change(screen.getByLabelText("App ID"), { target: { value: "cli_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(channelState.current.configure).toHaveBeenCalledWith(
        expect.objectContaining({ createNew: true, name: "New bot", appId: "cli_new" }),
      ),
    );

    cleanup();
    channelState.current.status = makeStatus([existingBot]);
    render(<LarkChannelSection serverId="server-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Delete bot" }));
    await waitFor(() => expect(channelState.current.deleteBot).toHaveBeenCalledWith("bot-1"));
  });
});
