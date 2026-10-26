/** @vitest-environment jsdom */
import { render, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  plugin: { lifetime: new AbortController() } as { lifetime: AbortController } | null,
  close: vi.fn(),
}));

function Children({ children }: { children: ReactNode }) {
  return children;
}

vi.mock("@getpaseo/plugin/client/host", () => ({ PluginClientStateProvider: Children }));
vi.mock("react-native-unistyles", () => ({ withUnistyles: (component: unknown) => component }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({}),
  useHosts: () => [],
}));
vi.mock("../client-state/source", () => ({ createPluginClientStateSource: () => ({}) }));
vi.mock("../installation-provider", () => ({ PluginInstallationProvider: Children }));
vi.mock("../host-navigation", () => ({ usePluginHostNavigation: () => ({}) }));
vi.mock("../layout", () => ({ usePluginLayout: () => ({}) }));
vi.mock("../registry", () => ({ useInstalledPlugin: () => state.plugin }));
vi.mock("../surface-error-boundary", () => ({
  SurfaceErrorBoundary: ({ Surface }: { Surface: () => ReactNode }) => <Surface />,
}));
vi.mock("../theme", () => ({ toPluginTheme: () => ({}) }));
vi.mock("./store", () => {
  const entries = [
    {
      key: 1,
      serverId: "host",
      pluginId: "todo",
      Component: () => <div>Overlay</div>,
      close: state.close,
    },
  ];
  return { pluginOverlayStore: { subscribe: () => () => {}, getSnapshot: () => entries } };
});

import { PluginOverlayHost } from "./host";

afterEach(() => {
  cleanup();
  state.close.mockClear();
  state.plugin = { lifetime: new AbortController() };
});

it("keeps an open overlay through presentation updates of the same installation", () => {
  const view = render(<PluginOverlayHost />);
  const lifetime = state.plugin!.lifetime;
  state.plugin = { lifetime };
  view.rerender(<PluginOverlayHost />);
  expect(state.close).not.toHaveBeenCalled();
  expect(view.queryByText("Overlay")).not.toBeNull();
});

it.each(["reload", "remove"])(
  "closes an overlay when its installation is replaced by %s",
  (action) => {
    const view = render(<PluginOverlayHost />);
    state.plugin = action === "reload" ? { lifetime: new AbortController() } : null;
    view.rerender(<PluginOverlayHost />);
    expect(state.close).toHaveBeenCalledOnce();
    expect(view.queryByText("Overlay")).toBeNull();
  },
);
