/** @vitest-environment jsdom */
import { useCallback, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_SETTINGS_KEY, useAppSettings } from "@/hooks/use-settings";
import { useBackgroundConnection } from "@/runtime/use-background-connection";
import { BackgroundConnectionSection } from "./background-connection-section";

const runtime = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  store: {},
  bind: vi.fn(),
  unbind: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => runtime.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void runtime.storage.set(key, value),
    removeItem: async (key: string) => void runtime.storage.delete(key),
  },
}));
vi.mock("@/runtime/background-connection", () => ({
  bindPlatformBackgroundConnection: runtime.bind,
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => runtime.store,
}));
vi.mock("react-native-unistyles", () => import("../../../../test-stubs/react-native-unistyles"));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/settings", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSwitch: function MockSettingsSwitch({
    label,
    value,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) {
    const handleClick = useCallback(() => onValueChange(!value), [onValueChange, value]);
    return (
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={value}
        onClick={handleClick}
      >
        {label}
      </button>
    );
  },
}));

function SettingsHarness() {
  const { settings, isLoading } = useAppSettings();
  useBackgroundConnection(!isLoading && settings.backgroundConnectionEnabled);
  return <BackgroundConnectionSection />;
}

beforeEach(() => {
  runtime.storage.clear();
  runtime.bind.mockReset().mockReturnValue(runtime.unbind);
  runtime.unbind.mockReset();
});

afterEach(() => cleanup());

it("persists the switch and starts or stops the background keeper", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SettingsHarness />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(runtime.storage.has(APP_SETTINGS_KEY)).toBe(true));
  const toggle = screen.getByRole("switch");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(runtime.bind).not.toHaveBeenCalled();

  fireEvent.click(toggle);
  await waitFor(() => expect(runtime.bind).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      JSON.parse(runtime.storage.get(APP_SETTINGS_KEY) ?? "{}").backgroundConnectionEnabled,
    ).toBe(true),
  );

  fireEvent.click(toggle);
  await waitFor(() => expect(runtime.unbind).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      JSON.parse(runtime.storage.get(APP_SETTINGS_KEY) ?? "{}").backgroundConnectionEnabled,
    ).toBe(false),
  );
  view.unmount();
  queryClient.clear();
});
