vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
  process.env.EXPO_OS = "web";
});

import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

vi.mock("react-native-unistyles", () => {
  const testTheme = {
    colors: {
      foreground: "#111111",
      foregroundMuted: "#666666",
      muted: "#f4f4f5",
      border: "#e4e4e7",
      surface1: "#fafafa",
      surface2: "#f4f4f5",
    },
    spacing: { 2: 8, 3: 12, 4: 16 },
    fontSize: { sm: 14, xs: 12 },
    borderRadius: { md: 6, sm: 4 },
  };
  return {
    StyleSheet: {
      create: (factory: unknown) => (typeof factory === "function" ? factory(testTheme) : factory),
    },
    withUnistyles: (Component: unknown) => Component,
    useUnistyles: () => ({ theme: testTheme }),
  };
});

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({
    error: vi.fn(),
  }),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      onPress,
      testID,
    }: {
      children: React.ReactNode;
      onPress?: () => void;
      testID?: string;
    }) =>
      ReactModule.createElement(
        "button",
        {
          "data-testid": testID,
          onClick: onPress,
          type: "button",
        },
        children,
      ),
  };
});

import { ContainerConfigChangedBanner } from "@/components/container-config-changed-banner";
import { useSessionStore, normalizeWorkspaceDescriptor } from "@/stores/session-store";
import { getHostRuntimeStore, type HostRuntimeController } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";

const SERVER_ID = "test-server";
const WORKSPACE_ID = "ws-test";

// ---------------------------------------------------------------------------
// Mock DaemonClient
// ---------------------------------------------------------------------------

function createMockClient(): DaemonClient {
  const configHandlers: Array<(wsId: string) => void> = [];
  return {
    onContainerConfigChanged: vi.fn((handler: (wsId: string) => void) => {
      configHandlers.push(handler);
      return () => {
        const idx = configHandlers.indexOf(handler);
        if (idx >= 0) configHandlers.splice(idx, 1);
      };
    }),
    rebuildContainer: vi.fn().mockResolvedValue(undefined),
    fireConfigChanged: (wsId: string) => {
      for (const h of configHandlers) h(wsId);
    },
  } as unknown as DaemonClient & {
    fireConfigChanged: (wsId: string) => void;
  };
}

// ---------------------------------------------------------------------------
// Store setup helpers
// ---------------------------------------------------------------------------

function makeHost(): HostProfile {
  const now = "2026-07-25T00:00:00.000Z";
  return {
    serverId: SERVER_ID,
    label: "Test Host",
    lifecycle: {},
    connections: [],
    preferredConnectionId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function setHostProfiles(hosts: HostProfile[]): void {
  const store = getHostRuntimeStore() as unknown as {
    setHostsAndSync: (hosts: HostProfile[]) => void;
  };
  store.setHostsAndSync(hosts);
}

function getHostController(): HostRuntimeController {
  const store = getHostRuntimeStore() as unknown as {
    controllers: Map<string, HostRuntimeController>;
  };
  const controller = store.controllers.get(SERVER_ID);
  if (!controller) {
    throw new Error("Host runtime controller was not initialized");
  }
  return controller;
}

function setClient(client: DaemonClient | null): void {
  const controller = getHostController() as unknown as {
    updateSnapshot: (patch: Record<string, unknown>) => void;
  };
  controller.updateSnapshot({ client });
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

let dom: JSDOM | null = null;

async function renderBanner(props: {
  serverId: string;
  workspaceId: string;
}): Promise<{ root: Root; container: HTMLElement }> {
  dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ContainerConfigChangedBanner, props));
  });
  return { root, container };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    setHostProfiles([makeHost()]);
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  });
});

afterEach(() => {
  dom?.window.close();
  dom = null;
});

describe("ContainerConfigChangedBanner", () => {
  it("shows rebuild button when container.config_changed event fires", async () => {
    const client = createMockClient();
    setClient(client);

    const { container } = await renderBanner({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(container.textContent).not.toContain("configChangedTitle");

    const mockClient = client as unknown as {
      fireConfigChanged: (wsId: string) => void;
    };
    await act(async () => {
      mockClient.fireConfigChanged(WORKSPACE_ID);
    });

    expect(container.textContent).toContain("workspace.header.container.configChangedTitle");
    expect(container.textContent).toContain("workspace.header.container.rebuildAction");
  });

  it("does not show banner when config_changed fires for a different workspace", async () => {
    const client = createMockClient();
    setClient(client);

    const { container } = await renderBanner({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });

    const mockClient = client as unknown as {
      fireConfigChanged: (wsId: string) => void;
    };
    await act(async () => {
      mockClient.fireConfigChanged("ws-different");
    });

    expect(container.textContent).not.toContain("configChangedTitle");
  });

  it("calls rebuildContainer when rebuild button is clicked", async () => {
    const client = createMockClient();
    setClient(client);

    const { container } = await renderBanner({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });

    const mockClient = client as unknown as {
      fireConfigChanged: (wsId: string) => void;
    };
    await act(async () => {
      mockClient.fireConfigChanged(WORKSPACE_ID);
    });

    const rebuildButton = container.querySelector(
      '[data-testid="container-rebuild"]',
    ) as HTMLElement | null;
    expect(rebuildButton).not.toBeNull();
    await act(async () => {
      rebuildButton?.click();
    });
    expect(client.rebuildContainer).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});

describe("normalizeWorkspaceDescriptor preserves container fields", () => {
  it("preserves containerBackend from the wire payload", () => {
    const descriptor = normalizeWorkspaceDescriptor({
      id: "ws-1",
      projectId: "prj-1",
      projectDisplayName: "Test",
      projectCustomName: null,
      projectRootPath: "/test",
      workspaceDirectory: "/test",
      projectKind: "non_git",
      workspaceKind: "local_checkout",
      name: "main",
      title: null,
      pinnedAt: null,
      status: "done",
      statusEnteredAt: null,
      archivingAt: null,
      activityAt: null,
      diffStat: null,
      scripts: [],
      containerBackend: "devcontainer",
      containerStatus: "running",
      hasDevContainerConfig: true,
      containerInfo: {
        backend: "devcontainer",
        containerId: "abc123",
        containerName: "test-container",
        image: "alpine:latest",
        startedAt: "2026-07-25T00:00:00Z",
        remoteUser: "root",
      },
    });
    expect(descriptor.containerBackend).toBe("devcontainer");
    expect(descriptor.containerStatus).toBe("running");
    expect(descriptor.hasDevContainerConfig).toBe(true);
    expect(descriptor.containerInfo).toEqual({
      backend: "devcontainer",
      containerId: "abc123",
      containerName: "test-container",
      image: "alpine:latest",
      startedAt: "2026-07-25T00:00:00Z",
      remoteUser: "root",
    });
  });

  it("preserves undefined containerBackend when not in the wire payload", () => {
    const descriptor = normalizeWorkspaceDescriptor({
      id: "ws-1",
      projectId: "prj-1",
      projectDisplayName: "Test",
      projectCustomName: null,
      projectRootPath: "/test",
      workspaceDirectory: "/test",
      projectKind: "non_git",
      workspaceKind: "local_checkout",
      name: "main",
      title: null,
      pinnedAt: null,
      status: "done",
      statusEnteredAt: null,
      archivingAt: null,
      activityAt: null,
      diffStat: null,
      scripts: [],
    });
    expect(descriptor.containerBackend).toBeUndefined();
    expect(descriptor.containerStatus).toBeUndefined();
  });
});
