import { describe, expect, it } from "vitest";
import { buildSshTunnelArgs, parseSshTransportUri, validateSshHost } from "./ssh-transport.js";

describe("SSH transport", () => {
  it("parses SSH targets with Paseo's default daemon port", () => {
    expect(parseSshTransportUri("ssh://deploy@example.com:2222")).toEqual({
      host: "deploy@example.com",
      sshPort: 2222,
      daemonPort: 6767,
    });
  });

  it("accepts an explicit remote daemon port", () => {
    expect(parseSshTransportUri("ssh://build-box?daemonPort=7777")).toEqual({
      host: "build-box",
      daemonPort: 7777,
    });
  });

  it("passes IPv6 hosts to OpenSSH without URI brackets", () => {
    expect(parseSshTransportUri("ssh://deploy@[2001:db8::1]:2222")).toEqual({
      host: "deploy@2001:db8::1",
      sshPort: 2222,
      daemonPort: 6767,
    });
  });

  it.each([
    "http://build-box",
    "ssh://build-box/path",
    "ssh://build-box?unknown=true",
    "ssh://build-box?daemonPort=0",
    "ssh://user:secret@build-box",
  ])("rejects invalid target %s", (target) => {
    expect(() => parseSshTransportUri(target)).toThrow();
  });

  it("builds a non-interactive stdio tunnel and preserves SSH config", () => {
    expect(
      buildSshTunnelArgs({
        host: "deploy@build-box",
        sshPort: 2222,
        daemonPort: 7777,
      }),
    ).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-p",
      "2222",
      "-W",
      "127.0.0.1:7777",
      "deploy@build-box",
    ]);
  });

  it.each(["", "-oProxyCommand=bad", "bad host"])("rejects unsafe SSH host %j", (host) => {
    expect(() => validateSshHost(host)).toThrow();
  });
});
