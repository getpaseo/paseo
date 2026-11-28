import React, { type ReactNode } from "react";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient, type FileReadResult } from "@getpaseo/client/internal/daemon-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssistantFileLinkResolverProvider,
  useAssistantFileLinkEnvironmentBridge,
} from "@/assistant-file-links";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type { AttachmentStore } from "@/attachments/types";
import { PENDING_MARKDOWN_IMAGE } from "@/components/markdown/source";
import { i18n } from "@/i18n/i18next";
import {
  getHostRuntimeStore,
  type HostRuntimeController,
  type HostRuntimeSnapshot,
} from "@/runtime/host-runtime";
import { seedSessionHosts } from "@/test/seed-session";
import {
  PluginInstallationProvider,
  usePluginInstallationServerIdBridge,
} from "../installation-provider";
import type { InstalledPlugin } from "../types";
import { Markdown } from "./markdown";

// Valid 1x1 PNG so Chromium's Image decoder reports naturalWidth = 1, naturalHeight = 1.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URI = `data:image/png;base64,${TINY_PNG_BASE64}`;
const TINY_PNG_BYTES = Uint8Array.from(atob(TINY_PNG_BASE64), (character) =>
  character.charCodeAt(0),
);

function createMemoryAttachmentStore(): AttachmentStore {
  const bytesById = new Map<string, { bytes: Uint8Array<ArrayBuffer>; mimeType: string }>();
  const objectUrls = new Set<string>();
  return {
    storageType: "web-indexeddb",
    async save(input) {
      const id = input.id ?? `att_${bytesById.size + 1}`;
      const rawBytes =
        input.source.kind === "bytes" ? new Uint8Array(input.source.bytes) : new Uint8Array();
      bytesById.set(id, {
        bytes: rawBytes,
        mimeType: input.mimeType ?? "image/png",
      });
      return {
        id,
        mimeType: input.mimeType ?? "image/png",
        storageType: "web-indexeddb",
        storageKey: id,
        fileName: input.fileName,
        createdAt: 1,
      };
    },
    async encodeBase64() {
      return TINY_PNG_BASE64;
    },
    async readBytes({ attachment }) {
      return bytesById.get(attachment.id)?.bytes ?? TINY_PNG_BYTES;
    },
    async resolvePreviewUrl({ attachment }) {
      const stored = bytesById.get(attachment.id);
      const blob = new Blob([stored?.bytes ?? TINY_PNG_BYTES], {
        type: stored?.mimeType ?? "image/png",
      });
      const url = URL.createObjectURL(blob);
      objectUrls.add(url);
      return url;
    },
    async releasePreviewUrl({ url }) {
      if (objectUrls.has(url)) {
        URL.revokeObjectURL(url);
        objectUrls.delete(url);
      }
    },
    async delete({ attachment }) {
      bytesById.delete(attachment.id);
    },
    async garbageCollect() {},
  };
}

const createdClients: DaemonClient[] = [];

function createFakeHostClient() {
  const reads: { cwd: string; path: string }[] = [];
  const client = new DaemonClient({
    url: "ws://127.0.0.1:1",
    clientId: `plugin-markdown-host-${createdClients.length + 1}`,
    reconnect: { enabled: false },
  });
  client.readFile = async (cwd: string, path: string): Promise<FileReadResult> => {
    reads.push({ cwd, path });
    return {
      kind: "image",
      path,
      mime: "image/png",
      size: TINY_PNG_BYTES.byteLength,
      modifiedAt: "2026-11-28T00:00:00.000Z",
      bytes: TINY_PNG_BYTES,
    };
  };
  createdClients.push(client);
  return { reads, client };
}

function setHostRuntimeClient(serverId: string, client: DaemonClient | null) {
  const controllers = (
    getHostRuntimeStore() as unknown as {
      controllers: Map<string, HostRuntimeController>;
    }
  ).controllers;
  const controller = controllers.get(serverId);
  if (!controller) throw new Error(`Host runtime controller for ${serverId} was not initialized`);
  (
    controller as unknown as {
      updateSnapshot: (
        patch: Partial<Omit<HostRuntimeSnapshot, "serverId" | "clientGeneration">>,
      ) => void;
    }
  ).updateSnapshot({ client });
}

function createInstalledPlugin(serverId: string): InstalledPlugin {
  return {
    id: "dashboard",
    serverId,
    clientBundle: "",
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    paseo: createPaseoApi(
      new DaemonClient({
        url: "ws://127.0.0.1:1",
        clientId: "plugin-markdown-test",
        reconnect: { enabled: false },
      }),
    ),
    invoke: async () => ({}),
    subscribe: () =>
      Object.assign(() => undefined, {
        ready: Promise.resolve(),
        release: () => Promise.resolve(),
      }),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    cleanup: () => undefined,
    settingsScreens: [],
    surfaces: [],
    sidebarViews: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    workspaceRowBadgeItems: [],
    filePanels: [],
    composerItems: [],
    newWorkspaceItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    notificationOpenHandlers: [],
  };
}

const createdPlugins: InstalledPlugin[] = [];

function makePlugin(serverId: string): InstalledPlugin {
  const plugin = createInstalledPlugin(serverId);
  createdPlugins.push(plugin);
  return plugin;
}

async function expectLoadedImage(
  root: ParentNode,
  alt: string,
  expectedSrcPrefix: string,
): Promise<HTMLImageElement> {
  let matched: HTMLImageElement | null = null;
  await waitFor(() => {
    const img = root.querySelector<HTMLImageElement>(`img[alt="${alt}"]`);
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).not.toBe(PENDING_MARKDOWN_IMAGE);
    expect(img?.getAttribute("src")?.startsWith(expectedSrcPrefix)).toBe(true);
    expect(img?.complete).toBe(true);
    expect(img?.naturalWidth).toBeGreaterThan(0);
    matched = img;
  });
  return matched!;
}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  __setAttachmentStoreForTests(createMemoryAttachmentStore());
});

afterEach(async () => {
  cleanup();
  getHostRuntimeStore().syncHosts([]);
  for (const client of createdClients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const plugin of createdPlugins.splice(0)) {
    plugin.lifetime.abort();
    await plugin.paseo.dispose();
  }
  __setAttachmentStoreForTests(null);
});

describe("plugin Markdown local images", () => {
  it("loads local absolute and file:// PNG paths through the plugin host client", async () => {
    const serverId = "srv_plugin_markdown_abs";
    seedSessionHosts([serverId]);
    const host = createFakeHostClient();
    setHostRuntimeClient(serverId, host.client);
    const plugin = makePlugin(serverId);

    const { container } = render(
      <PluginInstallationProvider plugin={plugin}>
        <Markdown>
          {"![Before](/tmp/screenshots/before.png)\n\n![After](file:///tmp/screenshots/after.png)"}
        </Markdown>
      </PluginInstallationProvider>,
    );

    await expectLoadedImage(container, "Before", "blob:");
    await expectLoadedImage(container, "After", "blob:");
    expect(host.reads).toEqual([
      { cwd: "/", path: "/tmp/screenshots/before.png" },
      { cwd: "/", path: "/tmp/screenshots/after.png" },
    ]);
  });

  it("renders data: URLs directly without calling host readFile", async () => {
    const serverId = "srv_plugin_markdown_direct";
    seedSessionHosts([serverId]);
    const host = createFakeHostClient();
    setHostRuntimeClient(serverId, host.client);
    const plugin = makePlugin(serverId);

    const { container } = render(
      <PluginInstallationProvider plugin={plugin}>
        <Markdown>{`![Inline](${TINY_PNG_DATA_URI})`}</Markdown>
      </PluginInstallationProvider>,
    );

    await expectLoadedImage(container, "Inline", "data:image/png;base64,");
    expect(host.reads).toEqual([]);
  });

  it("keeps local images pending while the plugin host is disconnected and resolves once connected", async () => {
    const serverId = "srv_plugin_markdown_reconnect";
    seedSessionHosts([serverId]);
    setHostRuntimeClient(serverId, null);
    const plugin = makePlugin(serverId);

    const { container } = render(
      <PluginInstallationProvider plugin={plugin}>
        <Markdown>{"![Deferred](/tmp/screenshots/deferred.png)"}</Markdown>
      </PluginInstallationProvider>,
    );

    await waitFor(() => {
      const img = container.querySelector<HTMLImageElement>('img[alt="Deferred"]');
      expect(img).not.toBeNull();
      expect(img?.getAttribute("src")).toBe(PENDING_MARKDOWN_IMAGE);
    });

    const host = createFakeHostClient();
    setHostRuntimeClient(serverId, host.client);

    await expectLoadedImage(container, "Deferred", "blob:");
    expect(host.reads).toEqual([{ cwd: "/", path: "/tmp/screenshots/deferred.png" }]);
  });

  it("falls back cleanly to alt text when rendered outside any plugin host", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <Markdown>{"![Missing](/tmp/screenshots/missing.png)"}</Markdown>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector('img[alt="Missing"]')).toBeNull();
      expect(container.textContent).toContain("Missing");
    });
  });

  it("preserves the plugin host context across a separate portal tree via its bridge", async () => {
    const serverId = "srv_plugin_markdown_portal";
    seedSessionHosts([serverId]);
    const host = createFakeHostClient();
    setHostRuntimeClient(serverId, host.client);
    const plugin = makePlugin(serverId);

    let capturedBridge: ((children: ReactNode) => ReactNode) | null = null;
    function CaptureBridge() {
      const bridgeServerId = usePluginInstallationServerIdBridge();
      const bridgeFileLinks = useAssistantFileLinkEnvironmentBridge();
      capturedBridge = (children) => (
        <QueryClientProvider client={plugin.queryClient}>
          {bridgeFileLinks(bridgeServerId(children))}
        </QueryClientProvider>
      );
      return null;
    }

    render(
      <PluginInstallationProvider plugin={plugin}>
        <CaptureBridge />
      </PluginInstallationProvider>,
    );
    const bridge = capturedBridge as ((children: ReactNode) => ReactNode) | null;
    if (!bridge) throw new Error("Expected portal bridge to be captured");

    const portalHost = document.createElement("div");
    document.body.append(portalHost);
    const portal = render(
      <>{bridge(<Markdown>{"![ModalShot](/tmp/screenshots/modal.png)"}</Markdown>)}</>,
      { container: portalHost },
    );
    try {
      await expectLoadedImage(portalHost, "ModalShot", "blob:");
      expect(host.reads).toEqual([{ cwd: "/", path: "/tmp/screenshots/modal.png" }]);
    } finally {
      portal.unmount();
      portalHost.remove();
    }
  });

  it("resolves workspace-relative images on the same host and never borrows a different host's workspace client", async () => {
    const pluginHostId = "srv_plugin_ws_same";
    const otherHostId = "srv_plugin_ws_other";
    seedSessionHosts([pluginHostId, otherHostId]);
    const sameHost = createFakeHostClient();
    const otherHost = createFakeHostClient();
    setHostRuntimeClient(pluginHostId, sameHost.client);
    setHostRuntimeClient(otherHostId, null);

    const sameHostPlugin = makePlugin(pluginHostId);
    const { container, unmount } = render(
      <AssistantFileLinkResolverProvider
        serverId={pluginHostId}
        workspaceRoot="/repo"
        client={sameHost.client}
      >
        <PluginInstallationProvider plugin={sameHostPlugin}>
          <Markdown>{"![Chart](docs/chart.png)"}</Markdown>
        </PluginInstallationProvider>
      </AssistantFileLinkResolverProvider>,
    );

    await expectLoadedImage(container, "Chart", "blob:");
    expect(sameHost.reads).toEqual([{ cwd: "/repo", path: "docs/chart.png" }]);
    unmount();

    const otherHostPlugin = makePlugin(otherHostId);
    const crossHost = render(
      <AssistantFileLinkResolverProvider
        serverId={pluginHostId}
        workspaceRoot="/repo"
        client={otherHost.client}
      >
        <PluginInstallationProvider plugin={otherHostPlugin}>
          <Markdown>{"![Isolated](/tmp/screenshots/isolated.png)"}</Markdown>
        </PluginInstallationProvider>
      </AssistantFileLinkResolverProvider>,
    );

    await waitFor(() => {
      const img = crossHost.container.querySelector<HTMLImageElement>('img[alt="Isolated"]');
      expect(img).not.toBeNull();
      expect(img?.getAttribute("src")).toBe(PENDING_MARKDOWN_IMAGE);
    });
    expect(otherHost.reads).toEqual([]);
  });
});
