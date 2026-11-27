import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TunnelEvent } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudflaredTunnelProvider } from "../server/cloudflared.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFakeCloudflared(scriptBody: string): Promise<{ dir: string; binary: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-fake-cloudflared-"));
  tempDirs.push(dir);
  const binary = path.join(dir, "cloudflared");
  await writeFile(binary, `#!${process.execPath}\n${scriptBody}\n`, "utf8");
  await chmod(binary, 0o755);
  return { dir, binary };
}

const unusedPaseo = {} as never;

describe("cloudflared-tunnel built-in plugin", () => {
  it("reports unavailable with install guidance when cloudflared is missing", async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "paseo-empty-path-"));
    tempDirs.push(emptyDir);
    const provider = createCloudflaredTunnelProvider({
      env: { ...process.env, PATH: emptyDir },
    });

    const status = await provider.status({
      paseo: unusedPaseo,
      signal: new AbortController().signal,
    });
    expect(status).toMatchObject({
      status: "unavailable",
      installUrl: expect.stringContaining("cloudflare.com"),
      fixHint: expect.stringContaining("cloudflared"),
    });
  });

  it("opens a quick tunnel, parses trycloudflare.com URL as ephemeral, and terminates on abort", async () => {
    const markerFile = path.join(os.tmpdir(), `paseo-cf-term-${Date.now()}-${Math.random()}.txt`);
    const { dir } = await createFakeCloudflared(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("cloudflared version 2026.5.0 (built 2026-05-01)");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(markerFile)}, "started:" + args.join(" "));
console.error("INF +------------------------------------------------------------+");
console.error("INF |  https://quick-demo-123.trycloudflare.com                  |");
console.error("INF +------------------------------------------------------------+");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(markerFile)}, "terminated");
  process.exit(0);
});
setInterval(() => {}, 10_000);
`);
    tempDirs.push(markerFile);

    const provider = createCloudflaredTunnelProvider({
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
    });

    const status = await provider.status({
      paseo: unusedPaseo,
      signal: new AbortController().signal,
    });
    expect(status).toEqual({
      status: "available",
      detail: "cloudflared version 2026.5.0 (built 2026-05-01) (quick tunnel)",
    });

    const controller = new AbortController();
    const events: TunnelEvent[] = [];
    let readyResolve!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    const running = provider.open(
      { id: "tun_1", host: "127.0.0.1", port: 4321, label: "External MCP" },
      {
        paseo: unusedPaseo,
        signal: controller.signal,
        report(event) {
          events.push(event);
          if (event.type === "ready") readyResolve();
        },
      },
    );

    await readyPromise;
    expect(await readFile(markerFile, "utf8")).toBe(
      "started:tunnel --no-autoupdate --url http://127.0.0.1:4321",
    );

    controller.abort();
    await running;

    expect(await readFile(markerFile, "utf8")).toBe("terminated");
    expect(events).toEqual([
      { type: "connecting" },
      {
        type: "ready",
        url: "https://quick-demo-123.trycloudflare.com",
        stability: "ephemeral",
      },
      { type: "closed", reason: "aborted" },
    ]);
  });

  it("supports named tunnels via TUNNEL_TOKEN env without --url, reports stable URL, and redacts token on failure", async () => {
    const captureFile = path.join(os.tmpdir(), `paseo-cf-named-${Date.now()}-${Math.random()}.txt`);
    const { binary } = await createFakeCloudflared(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("cloudflared version 2026.5.0");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
  args,
  token: process.env.TUNNEL_TOKEN ?? null,
}));
if (process.env.TUNNEL_TOKEN === "bad-secret-token") {
  console.error("ERR invalid token bad-secret-token");
  process.exit(1);
}
console.error("INF Registered tunnel connection connIndex=0");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 10_000);
`);
    tempDirs.push(captureFile);

    const provider = createCloudflaredTunnelProvider({
      readSettings: async () => ({
        binaryPath: binary,
        tunnelToken: "secret-named-token",
        publicBaseUrl: "https://mcp.example.com/",
      }),
    });

    const controller = new AbortController();
    const events: TunnelEvent[] = [];
    let readyResolve!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    const running = provider.open(
      { id: "tun_2", host: "127.0.0.1", port: 9000 },
      {
        paseo: unusedPaseo,
        signal: controller.signal,
        report(event) {
          events.push(event);
          if (event.type === "ready") readyResolve();
        },
      },
    );

    await readyPromise;
    expect(JSON.parse(await readFile(captureFile, "utf8"))).toEqual({
      args: ["tunnel", "--no-autoupdate", "run"],
      token: "secret-named-token",
    });

    controller.abort();
    await running;

    expect(events).toEqual([
      { type: "connecting" },
      { type: "ready", url: "https://mcp.example.com", stability: "stable" },
      { type: "closed", reason: "aborted" },
    ]);

    // Redacts token if named tunnel exits with an error containing the token
    const failingProvider = createCloudflaredTunnelProvider({
      readSettings: async () => ({
        binaryPath: binary,
        tunnelToken: "bad-secret-token",
        publicBaseUrl: "https://mcp.example.com",
      }),
    });
    await expect(
      failingProvider.open(
        { id: "tun_3", host: "127.0.0.1", port: 9000 },
        {
          paseo: unusedPaseo,
          signal: new AbortController().signal,
          report() {},
        },
      ),
    ).rejects.toThrow(/\[REDACTED\]/);
  });

  it("brackets IPv6 hosts when launching quick tunnels", async () => {
    const argsFile = path.join(os.tmpdir(), `paseo-cf-v6-${Date.now()}-${Math.random()}.txt`);
    const { binary } = await createFakeCloudflared(`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
console.error("INF https://ipv6-demo.trycloudflare.com");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 10_000);
`);
    tempDirs.push(argsFile);

    const provider = createCloudflaredTunnelProvider({
      readSettings: async () => ({ binaryPath: binary }),
    });
    const controller = new AbortController();
    let readyResolve!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    const running = provider.open(
      { id: "tun_v6", host: "::1", port: 4321 },
      {
        paseo: unusedPaseo,
        signal: controller.signal,
        report(event) {
          if (event.type === "ready") readyResolve();
        },
      },
    );

    await readyPromise;
    expect(JSON.parse(await readFile(argsFile, "utf8"))).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://[::1]:4321",
    ]);

    controller.abort();
    await running;
  });

  it("reports configuration error when tunnelToken is set without publicBaseUrl", async () => {
    const provider = createCloudflaredTunnelProvider({
      readSettings: async () => ({ tunnelToken: "only-token" }),
    });

    const status = await provider.status({
      paseo: unusedPaseo,
      signal: new AbortController().signal,
    });
    expect(status).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("publicBaseUrl"),
    });
  });
});
