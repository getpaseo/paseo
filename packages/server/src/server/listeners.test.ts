import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import { expect, test } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import { createDaemonListeners, createExtraListeners, findTailscaleAddress } from "./listeners.js";

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
  expect(findTailscaleAddress(() => ({ eth0: [ipv4("100.101.102.103")] }))).toBeNull();
  expect(findTailscaleAddress(() => ({ tailscale0: [ipv4("100.101.102.103")] }))).toBe(
    "100.101.102.103",
  );
  expect(
    findTailscaleAddress(() => ({
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
  ).toBe("100.120.121.122");
});

test.each(["100.101.102.103", "0.0.0.0"])(
  "recognizes Tailscale through main listener %s",
  (host) => {
    const listeners = createDaemonListeners({
      http: createServer(),
      listen: `${host}:6767`,
      overridden: false,
      getMain: () => ({ type: "tcp", host, port: 6767 }),
      getTailscaleAddress: () => "100.101.102.103",
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
    getTailscaleAddress: () => "100.101.102.103",
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
    getTailscaleAddress: () => null,
  });
  try {
    await listeners.apply(listen);
    expect(listeners.status()).toMatchObject({
      tailscale: { ip: null, address, state: "waiting" },
      extraListeners: [{ address, state: "waiting" }],
    });
  } finally {
    await listeners.stop();
  }
});
