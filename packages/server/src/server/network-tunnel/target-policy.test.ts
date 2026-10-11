import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/index";
import { describe, expect, it } from "vitest";
import {
  TunnelTargetError,
  approveAddresses,
  describeTunnelTarget,
  isDeniedAddress,
  normalizeAddress,
  type ResolvedTunnelAddress,
} from "./target-policy.js";

describe("tunnel target policy", () => {
  it.each<ResolvedTunnelAddress>([
    { address: "169.254.0.1", family: 4 },
    { address: "169.254.169.254", family: 4 },
    { address: "100.100.100.200", family: 4 },
    { address: "fe80::1", family: 6 },
    { address: "fd00:ec2::254", family: 6 },
    { address: "64:ff9b::a9fe:a9fe", family: 6 },
    { address: "64:ff9b::169.254.169.254", family: 6 },
    { address: "64:ff9b:1:a9fe:a9:fe00::", family: 6 },
    { address: "2002:a9fe:a9fe::", family: 6 },
    { address: "::a9fe:a9fe", family: 6 },
    { address: "::169.254.169.254", family: 6 },
    { address: "::ffff:0:a9fe:a9fe", family: 6 },
    { address: "64:FF9B::A9FE:A9FE", family: 6 },
    { address: "0064:FF9B:0:0:0:0:A9FE:A9FE", family: 6 },
  ])("denies $address", (address) => {
    expect(isDeniedAddress(address)).toBe(true);
  });

  it.each([
    "::ffff:169.254.169.254",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "0000:0000:0000:0000:0000:ffff:a9fe:a9fe",
  ])("normalizes the IPv4-mapped literal %s", (address) => {
    expect(normalizeAddress(address)).toEqual({ address: "169.254.169.254", family: 4 });
  });

  it("accepts a bracketed IPv4-mapped literal in the domain slot", () => {
    expect(describeTunnelTarget({ atyp: 3, address: "[::ffff:a9fe:a9fe]", port: 80 })).toEqual({
      kind: "literal",
      address: { address: "169.254.169.254", family: 4 },
    });
  });

  it.each(["2852039166", "0xa9fea9fe", "0251.0376.0251.0376"])(
    "resolves the alternative IPv4 literal %s before applying policy",
    (hostname) => {
      expect(describeTunnelTarget({ atyp: 3, address: hostname, port: 80 })).toEqual({
        kind: "name",
        hostname,
      });
    },
  );

  it("denies a mixed DNS response", () => {
    expect(() =>
      approveAddresses([
        { address: "10.0.0.10", family: 4 },
        { address: "64:ff9b::a9fe:a9fe", family: 6 },
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "TunnelTargetError",
        reason: TunnelCloseReason.PolicyDenied,
      }),
    );
  });

  it.each<ResolvedTunnelAddress>([
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
    { address: "10.0.0.1", family: 4 },
    { address: "172.16.0.1", family: 4 },
    { address: "192.168.0.1", family: 4 },
    { address: "fc00::1", family: 6 },
    { address: "64:ff9b::a00:1", family: 6 },
    { address: "64:ff9b:1:a00:0:100::", family: 6 },
    { address: "64:ff9b:1::a9fe:a9fe", family: 6 },
    { address: "2002:7f00:1::", family: 6 },
    { address: "::", family: 6 },
    { address: "::1", family: 6 },
    { address: "100.100.100.201", family: 4 },
    { address: "169.255.0.1", family: 4 },
    { address: "fec0::1", family: 6 },
    { address: "fd00:ec2::253", family: 6 },
  ])("allows $address", (address) => {
    expect(isDeniedAddress(address)).toBe(false);
    expect(approveAddresses([address])).toEqual([address]);
  });

  it("reports an empty DNS response as host not found", () => {
    expect(() => approveAddresses([])).toThrowError(
      new TunnelTargetError(TunnelCloseReason.HostNotFound, "Host has no addresses"),
    );
  });
});
