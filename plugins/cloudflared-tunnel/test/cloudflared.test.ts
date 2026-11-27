import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TunnelEvent } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflaredTunnelProvider } from "../server/cloudflared.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Writes a fake CLI that runs `script` with Node. Windows ignores shebangs, so it gets a `.cmd` launcher. */
async function writeFakeCli(dir: string, name: string, script: string): Promise<string> {
  if (process.platform === "win32") {
    const scriptPath = path.join(dir, `${name}.cjs`);
    await writeFile(scriptPath, script, "utf8");
    const launcher = path.join(dir, `${name}.cmd`);
    await writeFile(launcher, `@"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    return launcher;
  }
  const launcher = path.join(dir, name);
  await writeFile(launcher, `#!${process.execPath}\n${script}\n`, "utf8");
  await chmod(launcher, 0o755);
  return launcher;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function createFakeCloudflared(scriptBody: string): Promise<{ dir: string; binary: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-fake-cloudflared-"));
  tempDirs.push(dir);
  const binary = await writeFakeCli(dir, "cloudflared", scriptBody);
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
fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ pid: process.pid, args }));
console.error("INF +------------------------------------------------------------+");
console.error("INF |  https://quick-demo-123.trycloudflare.com                  |");
console.error("INF +------------------------------------------------------------+");
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
    const started = JSON.parse(await readFile(markerFile, "utf8")) as {
      pid: number;
      args: string[];
    };
    expect(started.args).toEqual(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4321"]);

    controller.abort();
    await running;

    await vi.waitFor(() => expect(isProcessAlive(started.pid)).toBe(false));
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

  it("fails the open when quick tunnel provisioning fails instead of reporting the API endpoint", async () => {
    const { binary } = await createFakeCloudflared(`
console.error('ERR Couldn\\'t start tunnel error="failed to request quick Tunnel: Post \\\\"https://api.trycloudflare.com/tunnel\\\\": dial tcp: lookup api.trycloudflare.com: no such host"');
process.exit(1);
`);
    const provider = createCloudflaredTunnelProvider({
      readSettings: async () => ({ binaryPath: binary }),
    });
    const events: TunnelEvent[] = [];

    await expect(
      provider.open(
        { id: "tun_offline", host: "127.0.0.1", port: 4321 },
        {
          paseo: unusedPaseo,
          signal: new AbortController().signal,
          report(event) {
            events.push(event);
          },
        },
      ),
    ).rejects.toThrow(/exited before tunnel became ready/);
    expect(events).toEqual([{ type: "connecting" }]);
  });
});
