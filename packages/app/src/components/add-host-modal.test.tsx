/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddHostModal } from "./add-host-modal";

const runtimeMocks = vi.hoisted(() => ({
  probeAndUpsertDirectConnection: vi.fn(),
}));
const platformMocks = vi.hoisted(() => ({ os: "ios" }));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return {
    ...actual,
    Platform: {
      ...(actual.Platform as object),
      get OS() {
        return platformMocks.os;
      },
    },
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [],
  useHostMutations: () => ({
    probeAndUpsertDirectConnection: runtimeMocks.probeAndUpsertDirectConnection,
  }),
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

const translations: Record<string, string> = {
  "pairing.direct.title": "Direct connection",
  "pairing.direct.helper": "Enter the address of a Paseo server.",
  "pairing.direct.fields.host": "Host",
  "pairing.direct.fields.port": "Port",
  "pairing.direct.fields.password": "Password",
  "pairing.direct.fields.optional": "Optional",
  "pairing.direct.fields.useSsl": "Use SSL",
  "pairing.direct.fields.connectionUri": "Connection URI",
  "pairing.direct.advanced.label": "Advanced",
  "pairing.direct.advanced.show": "Show advanced",
  "pairing.direct.advanced.hide": "Hide advanced",
  "pairing.direct.headers.title": "Custom headers",
  "pairing.direct.headers.add": "Add header",
  "pairing.direct.headers.name": "Name",
  "pairing.direct.headers.value": "Value",
  "pairing.direct.headers.remove": "Remove header",
  "pairing.direct.actions.cancel": "Cancel",
  "pairing.direct.actions.connect": "Connect",
  "pairing.direct.actions.connecting": "Connecting...",
  "pairing.direct.passwordVisibility.show": "Show password",
  "pairing.direct.passwordVisibility.hide": "Hide password",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await import("react");
  return {
    AdaptiveModalSheet: ({
      visible,
      children,
      testID,
    }: {
      visible: boolean;
      children: ReactNode;
      testID?: string;
    }) =>
      visible ? ReactModule.createElement("section", { "data-testid": testID }, children) : null,
    AdaptiveTextInput: ({
      testID,
      accessibilityLabel,
      value,
      onChangeText,
      editable,
    }: {
      testID?: string;
      accessibilityLabel?: string;
      value?: string;
      onChangeText?: (value: string) => void;
      editable?: boolean;
    }) =>
      ReactModule.createElement("input", {
        "data-testid": testID,
        "aria-label": accessibilityLabel,
        value: value ?? "",
        disabled: editable === false,
        onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
      }),
  };
});

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      onPress,
      disabled,
      testID,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      testID?: string;
    }) =>
      ReactModule.createElement(
        "button",
        {
          type: "button",
          "data-testid": testID,
          disabled: disabled || undefined,
          onClick: () => !disabled && onPress?.(),
        },
        children,
      ),
  };
});

beforeEach(() => {
  vi.stubGlobal("React", React);
  platformMocks.os = "ios";
  runtimeMocks.probeAndUpsertDirectConnection.mockReset();
  runtimeMocks.probeAndUpsertDirectConnection.mockResolvedValue({
    profile: {
      serverId: "srv_headers",
      label: "example.test",
      appearance: { color: "none", badgeDisplay: null },
      lifecycle: {},
      connections: [],
      preferredConnectionId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    serverId: "srv_headers",
    hostname: "example.test",
  });
});

afterEach(() => {
  cleanup();
  delete window.paseoDesktop;
  vi.unstubAllGlobals();
});

describe("AddHostModal custom headers", () => {
  it("hides custom header controls on web", () => {
    platformMocks.os = "web";
    render(<AddHostModal visible onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId("direct-host-advanced-toggle"));

    expect(screen.queryByText("Custom headers")).toBeNull();
    expect(screen.queryByTestId("direct-header-add")).toBeNull();
  });

  it("shows custom header controls in Electron", () => {
    platformMocks.os = "web";
    window.paseoDesktop = { platform: "darwin" };
    render(<AddHostModal visible onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId("direct-host-advanced-toggle"));

    expect(screen.getByText("Custom headers")).toBeTruthy();
    expect(screen.getByTestId("direct-header-add")).toBeTruthy();
  });

  it("adds and removes editable header rows", () => {
    render(<AddHostModal visible onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId("direct-host-advanced-toggle"));
    fireEvent.click(screen.getByTestId("direct-header-add"));

    expect(screen.getByTestId("direct-header-name-0")).toBeTruthy();
    expect(screen.getByTestId("direct-header-value-0")).toBeTruthy();

    fireEvent.click(screen.getByTestId("direct-header-remove-0"));

    expect(screen.queryByTestId("direct-header-name-0")).toBeNull();
    expect(screen.queryByTestId("direct-header-value-0")).toBeNull();
  });

  it("passes entered custom headers to the direct connection mutation", async () => {
    const onSaved = vi.fn();
    render(<AddHostModal visible onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByTestId("direct-host-input"), {
      target: { value: "example.test" },
    });
    fireEvent.click(screen.getByTestId("direct-host-advanced-toggle"));
    fireEvent.click(screen.getByTestId("direct-header-add"));
    fireEvent.change(screen.getByTestId("direct-header-name-0"), {
      target: { value: "X-Tenant" },
    });
    fireEvent.change(screen.getByTestId("direct-header-value-0"), {
      target: { value: "acme" },
    });
    fireEvent.click(screen.getByTestId("direct-host-submit"));

    await waitFor(() => {
      expect(runtimeMocks.probeAndUpsertDirectConnection).toHaveBeenCalledWith({
        endpoint: "example.test:6767",
        useTls: false,
        headers: { "X-Tenant": "acme" },
      });
    });
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv_headers", hostname: "example.test" }),
    );
  });
});
