import { describe, expect, it } from "vitest";
import {
  isBlockedTunnelIp,
  resolveAndValidateTunnelDestination,
  type HostResolver,
} from "./destination-policy.js";

describe("destination SSRF & DNS-rebinding policy", () => {
  it.each([
    "169.254.169.254",
    "169.254.0.1",
    "169.254.255.255",
    "100.100.100.200",
    "fe80::1",
    "FE80::abcd:1234",
    "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fe80::1%eth0",
    "fd00:ec2::254",
    "fd00:0ec2:0000:0000:0000:0000:0000:0254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "::ffff:100.100.100.200",
    "::ffff:6464:64c8",
  ])("blocks metadata and link-local address %s", (ip) => {
    expect(isBlockedTunnelIp(ip)).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "127.0.0.2",
    "::1",
    "::ffff:127.0.0.1",
    "10.0.0.5",
    "192.168.1.10",
    "172.16.0.1",
    "93.184.216.34",
    "2606:2800:220:1:248:1893:25c8:1946",
    "fc00::1",
    "fd00:ec2::253",
    "100.100.100.201",
    "169.253.255.255",
    "169.255.0.1",
  ])("allows loopback, ordinary private, and public address %s", (ip) => {
    expect(isBlockedTunnelIp(ip)).toBe(false);
  });

  it("blocks cloud metadata hostnames before DNS resolution", async () => {
    let called = false;
    const resolveHost: HostResolver = async () => {
      called = true;
      return [{ address: "127.0.0.1", family: 4 }];
    };

    for (const host of [
      "metadata.google.internal",
      "METADATA.GOOGLE.INTERNAL.",
      "sub.metadata.google.internal",
      "metadata.goog",
      "metadata.goog.",
    ]) {
      const result = await resolveAndValidateTunnelDestination(host, 80, resolveHost);
      expect(result).toEqual({
        ok: false,
        code: "policy_denied",
        message: expect.stringContaining("blocked"),
      });
    }
    expect(called).toBe(false);
  });

  it("resolves hostname once and returns validated IPs so caller dials IP directly", async () => {
    let lookups = 0;
    const resolveHost: HostResolver = async (host) => {
      lookups += 1;
      expect(host).toBe("example.test");
      return [{ address: "93.184.216.34", family: 4 }];
    };

    const result = await resolveAndValidateTunnelDestination("example.test", 443, resolveHost);
    expect(lookups).toBe(1);
    expect(result).toEqual({
      ok: true,
      addresses: [{ address: "93.184.216.34", family: 4 }],
      port: 443,
    });
  });

  it("rejects hostnames that resolve to any blocked address (mixed DNS rebinding defense)", async () => {
    const resolveHost: HostResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "::ffff:169.254.169.254", family: 6 },
    ];

    const result = await resolveAndValidateTunnelDestination(
      "rebind.attacker.test",
      80,
      resolveHost,
    );
    expect(result).toEqual({
      ok: false,
      code: "policy_denied",
      message: expect.stringContaining("blocked"),
    });
  });

  it("allows bracketed IPv6 loopback and *.localhost fallback when DNS returns ENOTFOUND", async () => {
    const ipv6 = await resolveAndValidateTunnelDestination("[::1]", 5173, async () => {
      throw new Error("should not call DNS for IP literals");
    });
    expect(ipv6).toEqual({
      ok: true,
      addresses: [{ address: "::1", family: 6 }],
      port: 5173,
    });

    const serviceLocalhost = await resolveAndValidateTunnelDestination(
      "web.localhost",
      6768,
      async () => {
        const err = new Error("ENOTFOUND") as NodeJS.ErrnoException;
        err.code = "ENOTFOUND";
        throw err;
      },
    );
    expect(serviceLocalhost).toEqual({
      ok: true,
      addresses: [{ address: "127.0.0.1", family: 4 }],
      port: 6768,
    });
  });

  it("returns dns_failed when non-localhost hostname resolution fails", async () => {
    const result = await resolveAndValidateTunnelDestination(
      "does-not-exist.invalid",
      80,
      async () => {
        const err = new Error("getaddrinfo ENOTFOUND") as NodeJS.ErrnoException;
        err.code = "ENOTFOUND";
        throw err;
      },
    );
    expect(result).toEqual({
      ok: false,
      code: "dns_failed",
      message: expect.stringContaining("ENOTFOUND"),
    });
  });
});
