import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TunnelEvent } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTailscaleFunnelProvider } from "../server/tailscale.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeTailscaleState {
  funnelPorts: Record<string, string>;
  history: string[][];
}

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

// Each `tailscale funnel` process owns one file in portsDir that records its pid. Like tailscaled
// with a foreground Funnel, a port counts as in use only while that process lives. Every call
// appends one history line. Separate files keep concurrent fake processes from overwriting each
// other's state.
async function createFakeTailscale(initial: {
  statusJson: Record<string, unknown>;
  funnelPorts?: Record<string, string>;
  funnelStatusFails?: boolean;
}): Promise<{ binary: string; readState: () => Promise<FakeTailscaleState> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-fake-tailscale-"));
  tempDirs.push(dir);
  const configFile = path.join(dir, "config.json");
  const historyFile = path.join(dir, "history.jsonl");
  const portsDir = path.join(dir, "ports");
  await mkdir(portsDir);
  await writeFile(
    configFile,
    JSON.stringify({
      statusJson: initial.statusJson,
      funnelStatusFails: initial.funnelStatusFails ?? false,
    }),
    "utf8",
  );
  await writeFile(historyFile, "", "utf8");
  // Ports configured outside Paseo stay in use for the whole test, so they belong to this process.
  for (const [port, target] of Object.entries(initial.funnelPorts ?? {})) {
    await writeFile(
      path.join(portsDir, port),
      JSON.stringify({ pid: process.pid, target }),
      "utf8",
    );
  }

  const binary = await writeFakeCli(
    dir,
    "tailscale",
    `const fs = require("node:fs");
const path = require("node:path");
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, "utf8"));
const portsDir = ${JSON.stringify(portsDir)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(historyFile)}, JSON.stringify(args) + "\\n");

if (args[0] === "status" && args[1] === "--json") {
  console.log(JSON.stringify(config.statusJson));
  process.exit(0);
}

if (args[0] === "funnel" && args[1] === "status" && args[2] === "--json") {
  if (config.funnelStatusFails) {
    console.error("funnel status failed");
    process.exit(1);
  }
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const tcp = {};
  for (const port of fs.readdirSync(portsDir)) {
    const { pid } = JSON.parse(fs.readFileSync(path.join(portsDir, port), "utf8"));
    if (isAlive(pid)) tcp[port] = { HTTPS: true };
  }
  console.log(JSON.stringify({ TCP: tcp }));
  process.exit(0);
}

// Foreground funnel: tailscaled keeps the configuration only while this process runs.
if (args[0] === "funnel" && args[1].startsWith("--https=")) {
  const portFile = path.join(portsDir, args[1].slice("--https=".length));
  fs.writeFileSync(portFile, JSON.stringify({ pid: process.pid, target: args[2] }));
  const removeConfig = () => {
    fs.rmSync(portFile, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", removeConfig);
  process.on("SIGINT", removeConfig);
  console.log("Available on the internet:");
  console.log("https://devbox.tailnet.ts.net/");
  console.log("Press Ctrl+C to exit.");
  setInterval(() => {}, 10_000);
  return;
}

console.error("Unexpected tailscale args:", args.join(" "));
process.exit(1);
`,
  );

  return {
    binary,
    readState: async () => {
      const funnelPorts: Record<string, string> = {};
      for (const port of await readdir(portsDir)) {
        const entry = JSON.parse(await readFile(path.join(portsDir, port), "utf8")) as {
          pid: number;
          target: string;
        };
        if (isProcessAlive(entry.pid)) funnelPorts[port] = entry.target;
      }
      const history = (await readFile(historyFile, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string[]);
      return { funnelPorts, history };
    },
  };
}

const unusedPaseo = {} as never;

describe("tailscale-funnel built-in plugin", () => {
  it("reports unavailable when tailscale CLI is missing", async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "paseo-empty-ts-path-"));
    tempDirs.push(emptyDir);
    const provider = createTailscaleFunnelProvider({
      env: { ...process.env, PATH: emptyDir },
    });

    const status = await provider.status({
      paseo: unusedPaseo,
      signal: new AbortController().signal,
    });
    expect(status).toMatchObject({
      status: "unavailable",
      installUrl: "https://tailscale.com/download",
    });
  });

  it("reports clear diagnostics when logged out, MagicDNS is off, or Funnel is disabled", async () => {
    const loggedOut = await createFakeTailscale({
      statusJson: { BackendState: "NeedsLogin", Self: {} },
    });
    expect(
      await createTailscaleFunnelProvider({ binary: loggedOut.binary }).status({
        paseo: unusedPaseo,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("NeedsLogin"),
    });

    const noMagicDns = await createFakeTailscale({
      statusJson: { BackendState: "Running", Self: { DNSName: "" } },
    });
    expect(
      await createTailscaleFunnelProvider({ binary: noMagicDns.binary }).status({
        paseo: unusedPaseo,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("MagicDNS"),
    });

    const noFunnel = await createFakeTailscale({
      statusJson: {
        BackendState: "Running",
        Self: { DNSName: "devbox.tailnet.ts.net.", Capabilities: [] },
      },
    });
    expect(
      await createTailscaleFunnelProvider({ binary: noFunnel.binary }).status({
        paseo: unusedPaseo,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("Funnel"),
    });
  });

  it("allocates ports 443, 8443, 10000, rejects a 4th exposure, and stops the foreground funnel on abort", async () => {
    const fake = await createFakeTailscale({
      statusJson: {
        BackendState: "Running",
        Self: {
          DNSName: "devbox.tailnet.ts.net.",
          Capabilities: ["https://tailscale.com/cap/funnel-v1"],
        },
      },
    });

    const provider = createTailscaleFunnelProvider({ binary: fake.binary });
    expect(
      await provider.status({
        paseo: unusedPaseo,
        signal: new AbortController().signal,
      }),
    ).toEqual({
      status: "available",
      detail: "devbox.tailnet.ts.net",
    });

    const openExposure = async (id: string, port: number, host = "127.0.0.1") => {
      const controller = new AbortController();
      const events: TunnelEvent[] = [];
      let resolveReady!: (url: string) => void;
      const ready = new Promise<string>((resolve) => {
        resolveReady = resolve;
      });
      const done = provider.open(
        { id, host, port },
        {
          paseo: unusedPaseo,
          signal: controller.signal,
          report(event) {
            events.push(event);
            if (event.type === "ready") resolveReady(event.url);
          },
        },
      );
      const url = await ready;
      return { controller, events, url, done };
    };

    const first = await openExposure("e1", 3001);
    const second = await openExposure("e2", 3002);
    const third = await openExposure("e3", 3003);

    expect(first.url).toBe("https://devbox.tailnet.ts.net");
    expect(second.url).toBe("https://devbox.tailnet.ts.net:8443");
    expect(third.url).toBe("https://devbox.tailnet.ts.net:10000");
    expect(first.events).toEqual([
      { type: "connecting" },
      { type: "ready", url: "https://devbox.tailnet.ts.net", stability: "stable" },
    ]);

    // 4th exposure fails cleanly because all 3 Funnel ports are in use.
    await expect(
      provider.open(
        { id: "e4", host: "127.0.0.1", port: 3004 },
        {
          paseo: unusedPaseo,
          signal: new AbortController().signal,
          report() {},
        },
      ),
    ).rejects.toThrow(/All 3 Tailscale Funnel HTTPS ports \(443, 8443, 10000\) are already in use/);

    // Abort the second exposure (port 8443) -> stops its foreground funnel and frees port 8443.
    second.controller.abort();
    await second.done;
    expect(second.events.at(-1)).toEqual({ type: "closed", reason: "aborted" });

    // Windows force-kills the launcher tree, so the funnel process can outlive `done` briefly.
    await vi.waitFor(async () =>
      expect((await fake.readState()).funnelPorts).toEqual({
        "443": "http://127.0.0.1:3001",
        "10000": "http://127.0.0.1:3003",
      }),
    );

    // A new exposure reuses the freed port 8443 and brackets IPv6 hosts.
    const fourth = await openExposure("e4", 3004, "::1");
    expect(fourth.url).toBe("https://devbox.tailnet.ts.net:8443");
    const stateWithIpv6 = await fake.readState();
    expect(stateWithIpv6.funnelPorts["8443"]).toBe("http://[::1]:3004");

    first.controller.abort();
    third.controller.abort();
    fourth.controller.abort();
    await Promise.all([first.done, third.done, fourth.done]);

    await vi.waitFor(async () => expect((await fake.readState()).funnelPorts).toEqual({}));
    const finalState = await fake.readState();
    expect(finalState.history).toContainEqual(["funnel", "--https=443", "http://127.0.0.1:3001"]);
    expect(finalState.history.flat()).not.toContain("--bg");
  });

  it("refuses to open when the current Funnel configuration cannot be read", async () => {
    const fake = await createFakeTailscale({
      statusJson: {
        BackendState: "Running",
        Self: {
          DNSName: "devbox.tailnet.ts.net.",
          Capabilities: ["https://tailscale.com/cap/funnel-v1"],
        },
      },
      funnelStatusFails: true,
    });
    const provider = createTailscaleFunnelProvider({ binary: fake.binary });

    await expect(
      provider.open(
        { id: "e1", host: "127.0.0.1", port: 3001 },
        { paseo: unusedPaseo, signal: new AbortController().signal, report() {} },
      ),
    ).rejects.toThrow(/Could not read the current Tailscale Funnel configuration/);

    const state = await fake.readState();
    expect(state.funnelPorts).toEqual({});
    expect(
      state.history.some((args) => args[0] === "funnel" && args[1]?.startsWith("--https=")),
    ).toBe(false);
  });
});
