/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PaseoAgentCatalogEntry,
  RedactedPaseoAgentProviderConfig,
} from "@getpaseo/protocol/messages";
import type {
  PaseoAgentOAuthCompleteResult,
  PaseoAgentOAuthStartResult,
  PaseoAgentSetProviderInput,
} from "@/hooks/use-paseo-agent-providers";

interface PaseoAgentProvidersHookMock {
  supported: boolean;
  catalogSupported: boolean;
  providers: RedactedPaseoAgentProviderConfig[];
  catalog: PaseoAgentCatalogEntry[];
  defaultModel: string | null;
  isLoading: boolean;
  isCatalogLoading: boolean;
  error: string | null;
  catalogError: string | null;
  refresh: () => Promise<void>;
  setProvider: (
    input: PaseoAgentSetProviderInput,
  ) => Promise<RedactedPaseoAgentProviderConfig | null>;
  startOAuth: (name: string, mode?: string) => Promise<PaseoAgentOAuthStartResult>;
  completeOAuth: (name: string) => Promise<PaseoAgentOAuthCompleteResult>;
}

const { hookState, hostRuntimeSnapshot, openExternalUrls, theme } = vi.hoisted(() => {
  const initialHookState: { current: PaseoAgentProvidersHookMock } = {
    current: {
      supported: true,
      catalogSupported: true,
      providers: [] as RedactedPaseoAgentProviderConfig[],
      catalog: [] as PaseoAgentCatalogEntry[],
      defaultModel: null as string | null,
      isLoading: false,
      isCatalogLoading: false,
      error: null as string | null,
      catalogError: null as string | null,
      refresh: vi.fn(async () => undefined),
      setProvider: vi.fn(async () => null as RedactedPaseoAgentProviderConfig | null),
      startOAuth: vi.fn(
        async (): Promise<PaseoAgentOAuthStartResult> => ({
          requestId: "oauth-start",
          success: true,
          name: "catalog-login",
          authorization: null,
          error: null,
        }),
      ),
      completeOAuth: vi.fn(
        async (): Promise<PaseoAgentOAuthCompleteResult> => ({
          requestId: "oauth-complete",
          success: true,
          name: "catalog-login",
          auth: { kind: "oauth", configured: true },
          error: null,
        }),
      ),
    },
  };

  return {
    hookState: initialHookState,
    hostRuntimeSnapshot: {
      current: {
        activeConnection: { type: "directSocket", endpoint: "socket", display: "socket" },
      } as {
        activeConnection: { type: string; endpoint: string; display: string } | null;
      } | null,
    },
    openExternalUrls: [] as string[],
    theme: {
      spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
      borderRadius: { md: 6, lg: 8 },
      fontSize: { xs: 11, sm: 13, base: 15 },
      fontWeight: { normal: "400", medium: "500" },
      opacity: { 50: 0.5 },
      colors: {
        foreground: "#fff",
        foregroundMuted: "#aaa",
        surface1: "#111",
        surface2: "#222",
        border: "#444",
        destructive: "#f00",
        statusSuccess: "#0f0",
      },
    },
  };
});

vi.mock("react-native", () => ({
  View: ({
    children,
    testID,
    role,
    accessibilityRole,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    testID?: string;
    role?: string;
    accessibilityRole?: string;
    accessibilityLabel?: string;
  }) =>
    React.createElement(
      "div",
      {
        "data-testid": testID,
        role: role ?? accessibilityRole,
        "aria-label": accessibilityLabel,
      },
      children,
    ),
  Text: ({ children, testID }: { children?: ReactNode; testID?: string; numberOfLines?: number }) =>
    React.createElement("span", { "data-testid": testID }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: {
      uniProps?: (theme: unknown) => Record<string, unknown>;
    } & Record<string, unknown>) => {
      const themed = uniProps ? uniProps(theme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    Bot: icon("Bot"),
    Plus: icon("Plus"),
  };
});

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    visible,
    header,
    children,
    footer,
    testID,
  }: {
    visible: boolean;
    header?: { title: string; back?: { label?: string; onPress: () => void } };
    children: ReactNode;
    footer?: ReactNode;
    testID?: string;
  }) =>
    visible ? (
      <section data-testid={testID}>
        <h1>{header?.title}</h1>
        {header?.back ? (
          <button type="button" onClick={header.back.onPress}>
            {header.back.label ?? "Back"}
          </button>
        ) : null}
        {children}
        {footer ? <footer>{footer}</footer> : null}
      </section>
    ) : null,
  AdaptiveTextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    testID,
    placeholder,
    secureTextEntry,
    editable = true,
    multiline,
  }: {
    value?: string;
    onChangeText?: (value: string) => void;
    accessibilityLabel?: string;
    testID?: string;
    placeholder?: string;
    secureTextEntry?: boolean;
    editable?: boolean;
    multiline?: boolean;
  }) => {
    function handleChange(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void {
      onChangeText?.(event.currentTarget.value);
    }

    const inputProps = {
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      disabled: !editable,
      onChange: handleChange,
      placeholder,
      value: value ?? "",
    };

    if (multiline) {
      return React.createElement("textarea", inputProps);
    }

    return React.createElement("input", {
      ...inputProps,
      type: secureTextEntry ? "password" : "text",
    });
  },
}));

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: (provider: string) => () =>
    React.createElement("span", { "data-icon": `provider-${provider}` }),
}));

vi.mock("@/components/provider-icon-name", () => ({
  resolveProviderIconName: (provider: string) =>
    provider === "known-icon" ? { kind: "builtin", id: provider } : { kind: "bot" },
}));

vi.mock("@/components/ui/external-link", () => ({
  ExternalLink: ({
    href,
    label,
    testID,
    accessibilityLabel,
  }: {
    href: string;
    label: string;
    testID?: string;
    accessibilityLabel?: string;
  }) => (
    <a href={href} data-testid={testID} aria-label={accessibilityLabel ?? label}>
      {label}
    </a>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button type="button" disabled={disabled} data-testid={testID} onClick={onPress}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));

vi.mock("@/hooks/use-paseo-agent-providers", () => ({
  usePaseoAgentProviders: () => hookState.current,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeSnapshot: () => hostRuntimeSnapshot.current,
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: async (url: string) => {
    openExternalUrls.push(url);
  },
}));

import { PaseoAgentSettingsSheet } from "./paseo-agent-settings-sheet";

function catalogEntry(overrides: Partial<PaseoAgentCatalogEntry>): PaseoAgentCatalogEntry {
  return {
    id: "catalog-alpha",
    label: "Catalog Alpha",
    iconName: "known-icon",
    docsUrl: "https://alpha.example.test/docs",
    api: "responses",
    baseUrl: "https://alpha.example.test",
    auth: { kind: "api_key", envVar: "ALPHA_API_KEY", keyUrl: "https://alpha.example.test/key" },
    models: [{ id: "alpha-fast", label: "Alpha Fast" }],
    ...overrides,
  };
}

function providerConfig(
  overrides: Partial<RedactedPaseoAgentProviderConfig>,
): RedactedPaseoAgentProviderConfig {
  return {
    name: "catalog-alpha",
    providerType: "catalog-alpha",
    models: [{ id: "alpha-fast" }],
    auth: { kind: "api_key", configured: true },
    available: true,
    ...overrides,
  };
}

function renderSheet() {
  return render(<PaseoAgentSettingsSheet serverId="server-1" visible onClose={vi.fn()} />);
}

function resetHookState() {
  hookState.current.supported = true;
  hookState.current.catalogSupported = true;
  hookState.current.providers = [];
  hookState.current.catalog = [];
  hookState.current.defaultModel = null;
  hookState.current.isLoading = false;
  hookState.current.isCatalogLoading = false;
  hookState.current.error = null;
  hookState.current.catalogError = null;
  hookState.current.refresh = vi.fn(async () => undefined);
  hookState.current.setProvider = vi.fn(async () => providerConfig({}));
  hookState.current.startOAuth = vi.fn(async () => ({
    requestId: "oauth-start",
    success: true,
    name: "catalog-login",
    authorization: null,
    error: null,
  }));
  hookState.current.completeOAuth = vi.fn(async () => ({
    requestId: "oauth-complete",
    success: true,
    name: "catalog-login",
    auth: { kind: "oauth", configured: true },
    error: null,
  }));
  hostRuntimeSnapshot.current = {
    activeConnection: { type: "directSocket", endpoint: "socket", display: "socket" },
  };
  openExternalUrls.splice(0);
}

describe("PaseoAgentSettingsSheet", () => {
  beforeEach(() => {
    resetHookState();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the catalog feature-gate message exactly once", () => {
    hookState.current.catalogSupported = false;

    renderSheet();

    expect(screen.getAllByText("Update the Paseo daemon to use this.")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Add model provider" })).toBeNull();
  });

  it("lists catalog entries in the provider picker and disables unknown auth kinds", () => {
    hookState.current.catalog = [
      catalogEntry({ label: "Alpha Provider" }),
      catalogEntry({
        id: "catalog-future",
        label: "Future Provider",
        auth: { kind: "future_auth", prompt: "not yet" },
      }),
    ];

    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Add model provider" }));

    expect(screen.getByText("Alpha Provider")).toBeTruthy();
    expect(screen.getByText("Future Provider")).toBeTruthy();
    expect(screen.getByTestId("paseo-agent-catalog-docs-catalog-alpha").getAttribute("href")).toBe(
      "https://alpha.example.test/docs",
    );
    expect(screen.getByText("Update the app to use this provider")).toBeTruthy();
    expect(
      (screen.getByTestId("paseo-agent-catalog-select-catalog-future") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("submits an api-key provider with an explicit key", async () => {
    hookState.current.catalog = [catalogEntry({ models: [] })];

    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Add model provider" }));
    fireEvent.click(screen.getByTestId("paseo-agent-catalog-select-catalog-alpha"));
    expect(screen.queryByLabelText("Provider name")).toBeNull();
    expect(screen.queryByLabelText("Models")).toBeNull();
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: " alpha-secret " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => {
      expect(hookState.current.setProvider).toHaveBeenCalledWith({
        name: "Catalog Alpha",
        providerType: "catalog-alpha",
        options: {
          apiKey: "alpha-secret",
        },
      } satisfies PaseoAgentSetProviderInput);
    });
  });

  it("submits an empty api-key field as a host env reference", async () => {
    hookState.current.catalog = [catalogEntry({})];

    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Add model provider" }));
    fireEvent.click(screen.getByTestId("paseo-agent-catalog-select-catalog-alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => {
      expect(hookState.current.setProvider).toHaveBeenCalledWith({
        name: "Catalog Alpha",
        providerType: "catalog-alpha",
        options: {
          apiKey: "$ALPHA_API_KEY",
          models: [{ id: "alpha-fast", label: "Alpha Fast" }],
        },
      } satisfies PaseoAgentSetProviderInput);
    });
  });

  it("starts browser oauth, opens the returned auth URL, and renders it by authorization kind", async () => {
    hookState.current.catalog = [
      catalogEntry({
        id: "catalog-login",
        label: "Catalog Login",
        auth: { kind: "oauth", flow: "login-flow" },
      }),
    ];
    hookState.current.startOAuth = vi.fn(async () => ({
      requestId: "oauth-start",
      success: true,
      name: "catalog-login",
      authorization: {
        kind: "auth_url",
        url: "https://login.example.test/oauth/authorize?state=abc",
        instructions: "Open the sign-in page",
      },
      error: null,
    }));

    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Add model provider" }));
    fireEvent.click(screen.getByTestId("paseo-agent-catalog-select-catalog-login"));
    fireEvent.click(screen.getByRole("button", { name: "Sign in with browser" }));

    await waitFor(() => {
      expect(openExternalUrls).toEqual(["https://login.example.test/oauth/authorize?state=abc"]);
      expect(hookState.current.startOAuth).toHaveBeenCalledWith("Catalog Login", "browser");
    });
    expect(screen.getByText("https://login.example.test/oauth/authorize?state=abc")).toBeTruthy();
    expect(screen.getByTestId("paseo-agent-oauth-url").getAttribute("href")).toBe(
      "https://login.example.test/oauth/authorize?state=abc",
    );
  });

  it("renders a device-code oauth authorization and completes it", async () => {
    hookState.current.catalog = [
      catalogEntry({
        id: "catalog-login",
        label: "Catalog Login",
        auth: { kind: "oauth", flow: "login-flow" },
      }),
    ];
    hookState.current.startOAuth = vi.fn(async () => ({
      requestId: "oauth-start",
      success: true,
      name: "catalog-login",
      authorization: {
        kind: "device_code",
        userCode: "CODE-123",
        verificationUri: "https://login.example.test/device",
        intervalSeconds: 5,
        expiresInSeconds: 600,
        instructions: "Enter the code",
      },
      error: null,
    }));

    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Add model provider" }));
    fireEvent.click(screen.getByTestId("paseo-agent-catalog-select-catalog-login"));
    fireEvent.click(screen.getByRole("button", { name: "Use a code instead" }));

    expect((await screen.findByTestId("paseo-agent-oauth-user-code")).textContent).toBe("CODE-123");
    expect(screen.getByText("https://login.example.test/device")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Complete sign in" }));

    await waitFor(() => {
      expect(hookState.current.setProvider).toHaveBeenCalledWith({
        name: "Catalog Login",
        providerType: "catalog-login",
        options: {
          models: [{ id: "alpha-fast", label: "Alpha Fast" }],
        },
      } satisfies PaseoAgentSetProviderInput);
      expect(hookState.current.startOAuth).toHaveBeenCalledWith("Catalog Login", "device_code");
      expect(hookState.current.completeOAuth).toHaveBeenCalledWith("Catalog Login");
    });
  });

  it("offers device-code first over relay while keeping browser available", () => {
    hostRuntimeSnapshot.current = {
      activeConnection: { type: "relay", endpoint: "relay.example.test:443", display: "relay" },
    };
    hookState.current.catalog = [
      catalogEntry({
        id: "catalog-login",
        label: "Catalog Login",
        auth: { kind: "oauth", flow: "login-flow" },
      }),
    ];

    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Add model provider" }));
    fireEvent.click(screen.getByTestId("paseo-agent-catalog-select-catalog-login"));

    const actionButtons = screen
      .getByTestId("paseo-agent-oauth-sign-in")
      .querySelectorAll("button");
    expect(Array.from(actionButtons).map((button) => button.textContent)).toEqual([
      "Providers",
      "Cancel",
      "Use a code instead",
      "Sign in with browser",
    ]);
  });

  it("shows auth-state badges from configured instances", () => {
    hookState.current.catalog = [
      catalogEntry({ id: "catalog-alpha", label: "Catalog Alpha" }),
      catalogEntry({ id: "catalog-beta", label: "Catalog Beta" }),
    ];
    hookState.current.providers = [
      providerConfig({ name: "alpha", providerType: "catalog-alpha" }),
      providerConfig({
        name: "beta",
        providerType: "catalog-beta",
        auth: { kind: "api_key", configured: false },
      }),
      providerConfig({ name: "legacy", providerType: "legacy-provider", auth: undefined }),
    ];

    renderSheet();

    expect(screen.getByText("Catalog Alpha · 1 model")).toBeTruthy();
    expect(screen.getByText("Catalog Beta · 1 model")).toBeTruthy();
    expect(screen.getByText("legacy-provider · 1 model")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
  });
});
