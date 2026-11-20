import { describe, expect, it } from "vitest";
import { resolveSshFailureDetail } from "../ssh/ssh-tunnel.js";
import { parseHostTarget } from "@getpaseo/client/node";

describe("CLI SSH transport", () => {
  it("surfaces SSH stderr before the child exit event settles", () => {
    expect(resolveSshFailureDetail(null, "Host key verification failed.\n")).toBe(
      "Host key verification failed.",
    );
    expect(resolveSshFailureDetail("ssh exited with code 255", "earlier stderr")).toBe(
      "ssh exited with code 255",
    );
  });
  it("uses the shared SSH target grammar and excludes reusable credentials from discovery", () => {
    expect(parseHostTarget("ssh://deploy@build-box:2222?daemonPort=7777")).toEqual({
      kind: "ssh",
      ssh: { host: "deploy@build-box", sshPort: 2222, daemonPort: 7777 },
      description: "ssh://build-box:2222 (daemon port 7777)",
    });
    expect(() => parseHostTarget("ssh://deploy:secret@build-box")).toThrow(
      "Invalid host connection",
    );
  });
});
