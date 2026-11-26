import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import { expect, test } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import {
  createDaemonListeners,
  createExtraListeners,
  inspectTailscaleNetwork,
  splitListen,
} from "./listeners.js";

test.each([
  "/tmp/paseo,qa.sock",
  "unix:///tmp/paseo,127.0.0.1:12345",
  String.raw`\\.\pipe\paseo,qa`,
  String.raw`pipe://\\.\pipe\paseo,qa`,
])("preserves the legacy socket or pipe path %s", (listen) => {
  expect(splitListen(listen)).toEqual([listen]);
});

test("retries an occupied extra listener and serves the original HTTP handler", async () => {
  const blocker = createTcpServer().listen(0, "127.0.0.2");
  await once(blocker, "listening");
  const address = blocker.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP");
  const extra = `127.0.0.2:${address.port}`;
  const http = createServer((_req, res) => res.end("shared"));
  const listeners = createExtraListeners(http, 25);
  try {
    await listeners.apply([extra]);
    expect(listeners.status()).toEqual([{ address: extra, state: "waiting" }]);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await expect.poll(() => listeners.status()).toEqual([{ address: extra, state: "listening" }]);
    expect(await (await fetch(`http://${extra}`)).text()).toBe("shared");
    await listeners.apply([]);
    expect(listeners.status()).toEqual([]);
    await expect(fetch(`http://${extra}`)).rejects.toThrow();
  } finally {
    await listeners.apply([]);
    blocker.close();
  }
});

test("requires a Tailscale interface name or IPv6 prefix alongside the IPv4 address", () => {
  function ipv4(address: string): NetworkInterfaceInfo {
    return {
      address,
      family: "IPv4",
      netmask: "255.255.255.255",
      internal: false,
      cidr: null,
      mac: "",
    };
  }
  expect(inspectTailscaleNetwork(() => ({ eth0: [ipv4("100.101.102.103")] }))).toEqual({
    addresses: [],
    otherAddresses: new Set(["100.101.102.103"]),
  });
  expect(inspectTailscaleNetwork(() => ({ tailscale0: [ipv4("100.101.102.103")] }))).toEqual({
    addresses: ["100.101.102.103"],
    otherAddresses: new Set(),
  });
  expect(
    inspectTailscaleNetwork(() => ({
      eth0: [ipv4("100.101.102.103")],
      utun4: [
        ipv4("100.120.121.122"),
        {
          address: "fd7a:115c:a1e0::123",
          family: "IPv6",
          netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          cidr: null,
          internal: false,
          mac: "",
          scopeid: 0,
        },
      ],
    })),
  ).toEqual({ addresses: ["100.120.121.122"], otherAddresses: new Set(["100.101.102.103"]) });
});

test.each(["100.101.102.103", "0.0.0.0"])(
  "recognizes Tailscale through main listener %s",
  (host) => {
    const listeners = createDaemonListeners({
      http: createServer(),
      listen: `${host}:6767`,
      overridden: false,
      getMain: () => ({ type: "tcp", host, port: 6767 }),
      getTailscaleNetwork: () => ({ addresses: ["100.101.102.103"], otherAddresses: new Set() }),
    });
    expect(listeners.status().tailscale).toMatchObject({
      state: "on",
      address: "100.101.102.103:6767",
      lockedBy: "main",
    });
  },
);

test.each([
  { type: "socket", path: "/tmp/paseo.sock" },
  { type: "pipe", path: String.raw`\\.\pipe\paseo` },
] as const)("reports a $type main listener separately from TCP", (main) => {
  const listeners = createDaemonListeners({
    http: createServer(),
    listen: main.path,
    overridden: false,
    getMain: () => main,
    getTailscaleNetwork: () => ({ addresses: ["100.101.102.103"], otherAddresses: new Set() }),
  });
  expect(listeners.status().tailscale).toMatchObject({
    state: "off",
    address: null,
    lockedBy: "main",
    mainIsSocket: true,
  });
});

test("shows the saved Tailscale listener waiting when the host has no Tailscale interface yet", async () => {
  const address = "100.127.255.254:6767";
  const listen = `127.0.0.1:6767,${address}`;
  const listeners = createDaemonListeners({
    http: createServer(),
    listen,
    overridden: false,
    getMain: () => ({ type: "tcp", host: "127.0.0.1", port: 6767 }),
    getTailscaleNetwork: () => ({ addresses: [], otherAddresses: new Set() }),
  });
  try {
    await listeners.apply(listen);
    expect(listeners.status()).toMatchObject({
      tailscale: { ip: null, address, state: "waiting" },
      extraListeners: [{ address, state: "waiting" }],
    });
    const change = listeners.prepareTailscaleChange(listen, false, undefined, false);
    expect(change).toMatchObject({ confirmationRequired: false, listen: "127.0.0.1:6767" });
    if (change.confirmationRequired) throw new Error("Unexpected confirmation");
    await change.apply();
    expect(listeners.status()).toMatchObject({
      tailscale: { ip: null, address: null, state: "unavailable" },
      extraListeners: [],
    });
  } finally {
    await listeners.stop();
  }
});

test("does not count an extra listener on a non-Tailscale interface in the shared range", async () => {
  const address = "100.127.255.254";
  const endpoint = `${address}:6767`;
  const listen = `127.0.0.1:6767,${endpoint}`;
  const listeners = createDaemonListeners({
    http: createServer(),
    listen,
    overridden: false,
    getMain: () => ({ type: "tcp", host: "127.0.0.1", port: 6767 }),
    getTailscaleNetwork: () => ({ addresses: [], otherAddresses: new Set([address]) }),
  });
  try {
    await listeners.apply(listen);
    expect(listeners.status(endpoint)).toMatchObject({
      tailscale: {
        ip: null,
        address: null,
        state: "unavailable",
        disconnectsCurrentConnection: false,
      },
      extraListeners: [{ address: endpoint }],
    });
  } finally {
    await listeners.stop();
  }
});
