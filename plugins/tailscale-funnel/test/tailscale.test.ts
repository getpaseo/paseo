import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TunnelEvent } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it } from "vitest";
import { createTailscaleFunnelProvider } from "../server/tailscale.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeTailscaleState {
  statusJson: Record<string, unknown>;
  funnelPorts: Record<string, string>;
  history: string[][];
}

async function createFakeTailscale(initial: {
  statusJson: Record<string, unknown>;
  funnelPorts?: Record<string, string>;
}): Promise<{ binary: string; stateFile: string; readState: () => Promise<FakeTailscaleState> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-fake-tailscale-"));
  tempDirs.push(dir);
  const stateFile = path.join(dir, "state.json");
  const initialState: FakeTailscaleState = {
    statusJson: initial.statusJson,
    funnelPorts: initial.funnelPorts ?? {},
    history: [],
  };
  await writeFile(stateFile, JSON.stringify(initialState, null, 2), "utf8");

  const binary = path.join(dir, "tailscale");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
state.history.push(args);

if (args[0] === "status" && args[1] === "--json") {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state.statusJson));
  process.exit(0);
}

if (args[0] === "funnel" && args[1] === "status" && args[2] === "--json") {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const tcp = {};
  for (const port of Object.keys(state.funnelPorts)) {
    tcp[port] = { HTTPS: true };
  }
  console.log(JSON.stringify({ TCP: tcp }));
  process.exit(0);
}

if (args[0] === "funnel" && args[1] === "--bg") {
  const httpsArg = args.find((a) => a.startsWith("--https="));
  const port = httpsArg ? httpsArg.slice("--https=".length) : "443";
  const target = args[args.length - 1];
  state.funnelPorts[port] = target;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.exit(0);
}

if (args[0] === "funnel" && args[args.length - 1] === "off") {
  const httpsArg = args.find((a) => a.startsWith("--https="));
  const port = httpsArg ? httpsArg.slice("--https=".length) : "443";
  delete state.funnelPorts[port];
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.exit(0);
}

console.error("Unexpected tailscale args:", args.join(" "));
process.exit(1);
`,
    "utf8",
  );
  await chmod(binary, 0o755);

  return {
    binary,
    stateFile,
    readState: async () => JSON.parse(await readFile(stateFile, "utf8")) as FakeTailscaleState,
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

  it("allocates ports 443, 8443, 10000, rejects a 4th exposure, and turns off ports on abort", async () => {
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

    // Abort the second exposure (port 8443) -> runs `tailscale funnel --https=8443 off` and frees port 8443.
    second.controller.abort();
    await second.done;
    expect(second.events.at(-1)).toEqual({ type: "closed", reason: "aborted" });

    const stateAfterClose = await fake.readState();
    expect(stateAfterClose.funnelPorts).toEqual({
      "443": "http://127.0.0.1:3001",
      "10000": "http://127.0.0.1:3003",
    });

    // A new exposure reuses the freed port 8443 and brackets IPv6 hosts.
    const fourth = await openExposure("e4", 3004, "::1");
    expect(fourth.url).toBe("https://devbox.tailnet.ts.net:8443");
    const stateWithIpv6 = await fake.readState();
    expect(stateWithIpv6.funnelPorts["8443"]).toBe("http://[::1]:3004");

    first.controller.abort();
    third.controller.abort();
    fourth.controller.abort();
    await Promise.all([first.done, third.done, fourth.done]);

    const finalState = await fake.readState();
    expect(finalState.funnelPorts).toEqual({});
    expect(finalState.history).toContainEqual(["funnel", "--https=443", "off"]);
    expect(finalState.history).toContainEqual(["funnel", "--https=8443", "off"]);
    expect(finalState.history).toContainEqual(["funnel", "--https=10000", "off"]);
  });
});
