import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  SessionInboundMessage,
  SessionOutboundMessage,
  TunnelExposure,
  TunnelProviderInfo,
} from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, test } from "vitest";
import { resolveDaemonVersion } from "../daemon-version.js";
import { BuiltinPluginLoader } from "./builtin/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeTunnelPlugin(options: {
  pluginId: string;
  providerId: string;
  markerFile: string;
}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `paseo-${options.pluginId}-`));
  roots.push(dir);
  await writeFile(
    path.join(dir, "paseo-plugin.json"),
    JSON.stringify({
      id: options.pluginId,
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(dir, "index.server.ts"),
    `import { appendFileSync } from "node:fs";
import type { PluginServerContext } from "@getpaseo/plugin/server";

const markerFile = ${JSON.stringify(options.markerFile)};

export default function contribute(server: PluginServerContext) {
  return server.registerTunnelProvider({
    id: ${JSON.stringify(options.providerId)},
    label: "Custom Tunnel",
    description: "Subprocess test tunnel provider.",
    docsUrl: "https://example.test/docs/tunnel",
    async status() {
      return { status: "available", detail: "ready-v1" };
    },
    async open(target, { report, signal }) {
      appendFileSync(markerFile, "open:" + target.id + ":" + target.host + ":" + target.port + "\\n");
      report({ type: "connecting" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) {
        report({ type: "closed", reason: "aborted-early" });
        return;
      }
      report({
        type: "ready",
        url: "https://" + (target.slug ?? target.id) + ".custom-tunnel.test",
        stability: "ephemeral",
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      appendFileSync(markerFile, "aborted:" + target.id + "\\n");
      report({ type: "closed", reason: "aborted" });
    },
  });
}
`,
  );
  return dir;
}

function sendRpc<TResponseType extends SessionOutboundMessage["type"]>(
  client: DaemonClient,
  message: SessionInboundMessage & { requestId: string },
  expectedType: TResponseType,
): Promise<Extract<SessionOutboundMessage, { type: TResponseType }>["payload"]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${expectedType} (${message.requestId})`));
    }, 15_000);
    const unsubscribe = client.subscribeRawMessages((outbound) => {
      if (outbound.type === "rpc_error" && outbound.payload.requestId === message.requestId) {
        clearTimeout(timer);
        unsubscribe();
        const error = new Error(outbound.payload.error) as Error & { code?: string };
        error.code = outbound.payload.code;
        reject(error);
        return;
      }
      if (
        outbound.type === expectedType &&
        "payload" in outbound &&
        "requestId" in outbound.payload &&
        outbound.payload.requestId === message.requestId
      ) {
        clearTimeout(timer);
        unsubscribe();
        resolve(
          outbound.payload as Extract<SessionOutboundMessage, { type: TResponseType }>["payload"],
        );
      }
    });
    client.sendSessionMessage(message);
  });
}

describe("pluggable tunnel providers E2E", () => {
  test("runs a custom tunnel provider in a plugin subprocess, streams lifecycle events, aborts cleanly, and tears down on reload and disable", async () => {
    const markerDir = await mkdtemp(path.join(tmpdir(), "paseo-tunnel-markers-"));
    roots.push(markerDir);
    const markerFile = path.join(markerDir, "events.log");

    const daemon = await createTestPaseoDaemon();
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.18.0",
    });

    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.features?.tunnelProviders).toBe(true);

      await client.patchDaemonConfig({ pluginsEnabled: true });
      const pluginDir = await writeTunnelPlugin({
        pluginId: "custom-tunnel-plugin",
        providerId: "custom-tunnel",
        markerFile,
      });
      await expect(client.installDirectoryPlugin(pluginDir)).resolves.toMatchObject({
        id: "custom-tunnel-plugin",
        status: "running",
      });

      // List providers
      const providersRes = await sendRpc(
        client,
        { type: "tunnel.providers.list.request", requestId: "req-providers" },
        "tunnel.providers.list.response",
      );
      expect(providersRes.providers).toEqual<TunnelProviderInfo[]>([
        {
          id: "custom-tunnel",
          pluginId: "custom-tunnel-plugin",
          label: "Custom Tunnel",
          description: "Subprocess test tunnel provider.",
          docsUrl: "https://example.test/docs/tunnel",
          availability: { status: "available", detail: "ready-v1" },
        },
      ]);

      // Observe exposures
      const observedEvents: TunnelExposure[] = [];
      const unsubscribeRaw = client.subscribeRawMessages((message) => {
        if (message.type === "tunnel.exposure.changed") {
          observedEvents.push(message.payload.exposure);
        }
      });
      const initialList = await sendRpc(
        client,
        { type: "tunnel.exposures.list.request", requestId: "req-observe", observe: true },
        "tunnel.exposures.list.response",
      );
      expect(initialList.exposures).toEqual([]);
      expect(initialList.subscriptionId).toBeTruthy();

      // Open exposure
      const opened = await sendRpc(
        client,
        {
          type: "tunnel.exposure.open.request",
          requestId: "req-open-1",
          id: "exp-mcp",
          providerId: "custom-tunnel",
          host: "127.0.0.1",
          port: 4321,
          label: "External MCP",
          slug: "mcp",
        },
        "tunnel.exposure.open.response",
      );
      expect(opened.exposure).toMatchObject({
        id: "exp-mcp",
        providerId: "custom-tunnel",
        target: { host: "127.0.0.1", port: 4321, label: "External MCP", slug: "mcp" },
        state: "ready",
        url: "https://mcp.custom-tunnel.test",
        stability: "ephemeral",
      });

      // Close exposure explicitly
      const closed = await sendRpc(
        client,
        {
          type: "tunnel.exposure.close.request",
          requestId: "req-close-1",
          exposureId: "exp-mcp",
        },
        "tunnel.exposure.close.response",
      );
      expect(closed).toEqual({
        requestId: "req-close-1",
        exposureId: "exp-mcp",
        closed: true,
      });

      // Verify full lifecycle event stream: connecting -> ready -> closed
      expect(observedEvents.map((entry) => entry.state)).toEqual(["connecting", "ready", "closed"]);

      const logAfterClose = await readFile(markerFile, "utf8");
      expect(logAfterClose).toContain("open:exp-mcp:127.0.0.1:4321");
      expect(logAfterClose).toContain("aborted:exp-mcp");

      // Open a second exposure and reload the plugin -> must tear down exposure cleanly
      await sendRpc(
        client,
        {
          type: "tunnel.exposure.open.request",
          requestId: "req-open-2",
          id: "exp-reload",
          providerId: "custom-tunnel",
          host: "127.0.0.1",
          port: 4322,
          slug: "svc",
        },
        "tunnel.exposure.open.response",
      );
      expect(daemon.daemon.tunnelManager.listExposures().map((e) => e.id)).toEqual(["exp-reload"]);

      await client.reloadPlugin("custom-tunnel-plugin");
      expect(daemon.daemon.tunnelManager.listExposures()).toEqual([]);
      const logAfterReload = await readFile(markerFile, "utf8");
      expect(logAfterReload).toContain("aborted:exp-reload");

      // Open a third exposure after reload, then disable plugin -> must tear down and unregister provider
      await sendRpc(
        client,
        {
          type: "tunnel.exposure.open.request",
          requestId: "req-open-3",
          id: "exp-disable",
          providerId: "custom-tunnel",
          host: "127.0.0.1",
          port: 4323,
          slug: "svc2",
        },
        "tunnel.exposure.open.response",
      );
      await client.disablePlugin("custom-tunnel-plugin");
      expect(daemon.daemon.tunnelManager.listExposures()).toEqual([]);
      expect(
        (
          await sendRpc(
            client,
            { type: "tunnel.providers.list.request", requestId: "req-providers-after" },
            "tunnel.providers.list.response",
          )
        ).providers,
      ).toEqual([]);
      const logAfterDisable = await readFile(markerFile, "utf8");
      expect(logAfterDisable).toContain("aborted:exp-disable");

      unsubscribeRaw();
    } finally {
      await client.close();
      await daemon.close();
    }
  }, 60_000);

  test("enforces tunnel.manage for mutating tunnel RPCs and daemon.read for read RPCs", async () => {
    const markerDir = await mkdtemp(path.join(tmpdir(), "paseo-tunnel-auth-"));
    roots.push(markerDir);
    const markerFile = path.join(markerDir, "events.log");

    const daemon = await createTestPaseoDaemon();
    const owner = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.18.0",
    });
    const reader = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.18.0",
      sessionPermissions: ["daemon.read"],
    });
    const workspaceOnly = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.18.0",
      sessionPermissions: ["workspace.read"],
    });
    const tunnelOperator = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.18.0",
      sessionPermissions: ["tunnel.manage"],
    });

    try {
      await owner.connect();
      await owner.patchDaemonConfig({ pluginsEnabled: true });
      const pluginDir = await writeTunnelPlugin({
        pluginId: "auth-tunnel-plugin",
        providerId: "auth-tunnel",
        markerFile,
      });
      await owner.installDirectoryPlugin(pluginDir);

      await Promise.all([reader.connect(), workspaceOnly.connect(), tunnelOperator.connect()]);

      // daemon.read can list providers and exposures, cannot open/close
      const readerProviders = await sendRpc(
        reader,
        { type: "tunnel.providers.list.request", requestId: "r1" },
        "tunnel.providers.list.response",
      );
      expect(readerProviders.providers.map((p) => p.id)).toEqual(["auth-tunnel"]);

      const readerExposures = await sendRpc(
        reader,
        { type: "tunnel.exposures.list.request", requestId: "r2" },
        "tunnel.exposures.list.response",
      );
      expect(readerExposures.exposures).toEqual([]);

      await expect(
        sendRpc(
          reader,
          {
            type: "tunnel.exposure.open.request",
            requestId: "r3",
            providerId: "auth-tunnel",
            host: "127.0.0.1",
            port: 5000,
          },
          "tunnel.exposure.open.response",
        ),
      ).rejects.toMatchObject({ code: "access_denied" });

      await expect(
        sendRpc(
          reader,
          {
            type: "tunnel.exposure.close.request",
            requestId: "r4",
            exposureId: "exp-1",
          },
          "tunnel.exposure.close.response",
        ),
      ).rejects.toMatchObject({ code: "access_denied" });

      // workspace.read is denied on read tunnel RPCs too
      await expect(
        sendRpc(
          workspaceOnly,
          { type: "tunnel.providers.list.request", requestId: "w1" },
          "tunnel.providers.list.response",
        ),
      ).rejects.toMatchObject({ code: "access_denied" });

      // tunnel.manage can list, open, and close
      const opened = await sendRpc(
        tunnelOperator,
        {
          type: "tunnel.exposure.open.request",
          requestId: "t1",
          id: "exp-auth",
          providerId: "auth-tunnel",
          host: "127.0.0.1",
          port: 5001,
        },
        "tunnel.exposure.open.response",
      );
      expect(opened.exposure.state).toBe("ready");

      const closed = await sendRpc(
        tunnelOperator,
        {
          type: "tunnel.exposure.close.request",
          requestId: "t2",
          exposureId: "exp-auth",
        },
        "tunnel.exposure.close.response",
      );
      expect(closed.closed).toBe(true);
    } finally {
      await Promise.all([
        owner.close(),
        reader.close(),
        workspaceOnly.close(),
        tunnelOperator.close(),
      ]);
      await daemon.close();
    }
  }, 60_000);

  test("boots built-in cloudflared-tunnel and tailscale-funnel plugins cleanly without credentials", async () => {
    const daemon = await createTestPaseoDaemon({
      pluginsEnabled: false,
      builtinPlugins: new BuiltinPluginLoader(undefined, [
        "cloudflared-tunnel",
        "tailscale-funnel",
      ]),
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.18.0",
    });

    try {
      await client.connect();
      const res = await sendRpc(
        client,
        { type: "tunnel.providers.list.request", requestId: "builtin-1" },
        "tunnel.providers.list.response",
      );
      expect(res.providers.map((provider) => provider.id)).toEqual([
        "cloudflared",
        "tailscale-funnel",
      ]);
      for (const provider of res.providers) {
        expect(["available", "unavailable"]).toContain(provider.availability.status);
      }
    } finally {
      await client.close();
      await daemon.close();
    }
  }, 60_000);
});
