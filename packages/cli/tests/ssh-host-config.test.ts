import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTALL_DIR,
  DEFAULT_REMOTE_HOME,
  DEFAULT_REMOTE_PORT,
  DEFAULT_SSH_PORT,
  isSshHostUri,
  isValidSshHostId,
  normalizeSshHostConfig,
  parseSshHostUri,
  resolveSshHostConfig,
} from "../src/ssh/ssh-host-config.js";

describe("ssh-host-config: normalizeSshHostConfig", () => {
  it("applies defaults for omitted fields", () => {
    const config = normalizeSshHostConfig({
      id: "prod",
      host: "10.0.0.5",
      user: "deploy",
    });
    expect(config.port).toBe(DEFAULT_SSH_PORT);
    expect(config.remotePort).toBe(DEFAULT_REMOTE_PORT);
    expect(config.remoteHome).toBe(DEFAULT_REMOTE_HOME);
    expect(config.installDir).toBe(DEFAULT_INSTALL_DIR);
    expect(config.label).toBe("deploy@10.0.0.5");
    expect(config.packageVersion).toBeUndefined();
  });

  it("preserves explicit values", () => {
    const config = normalizeSshHostConfig({
      id: "prod",
      host: "10.0.0.5",
      user: "deploy",
      port: 2222,
      remotePort: 7000,
      remoteHome: "/data/paseo",
      installDir: "/opt/paseo",
      label: "Production",
      packageVersion: "0.2.0",
    });
    expect(config).toMatchObject({
      port: 2222,
      remotePort: 7000,
      remoteHome: "/data/paseo",
      installDir: "/opt/paseo",
      label: "Production",
      packageVersion: "0.2.0",
    });
  });

  it("rejects invalid ids", () => {
    expect(() => normalizeSshHostConfig({ id: "Bad ID", host: "h", user: "u" })).toThrow();
    expect(() => normalizeSshHostConfig({ id: "", host: "h", user: "u" })).toThrow();
    expect(() => normalizeSshHostConfig({ id: "1".repeat(64), host: "h", user: "u" })).toThrow();
  });

  it("rejects empty host but accepts empty user", () => {
    expect(() => normalizeSshHostConfig({ id: "x", host: "  " })).toThrow();
    expect(() => normalizeSshHostConfig({ id: "x", host: "h" })).not.toThrow();
  });

  it("rejects out-of-range ports", () => {
    expect(() => normalizeSshHostConfig({ id: "x", host: "h", user: "u", port: 0 })).toThrow();
    expect(() => normalizeSshHostConfig({ id: "x", host: "h", user: "u", port: 99999 })).toThrow();
    expect(() =>
      normalizeSshHostConfig({ id: "x", host: "h", user: "u", remotePort: 0 }),
    ).toThrow();
  });
});

describe("ssh-host-config: isValidSshHostId / isSshHostUri", () => {
  it("validates id pattern", () => {
    expect(isValidSshHostId("my-host")).toBe(true);
    expect(isValidSshHostId("a")).toBe(true);
    expect(isValidSshHostId("My_Host")).toBe(false);
    expect(isValidSshHostId("-leading")).toBe(false);
  });

  it("detects ssh URIs", () => {
    expect(isSshHostUri("ssh://myhost")).toBe(true);
    expect(isSshHostUri("ssh://user@host")).toBe(true);
    expect(isSshHostUri("tcp://localhost:6767")).toBe(false);
    expect(isSshHostUri("localhost:6767")).toBe(false);
    expect(isSshHostUri("")).toBe(false);
  });
});

describe("ssh-host-config: parseSshHostUri", () => {
  it("parses a bare hostname (no user) as an inline host", () => {
    const parsed = parseSshHostUri("ssh://server.example.com");
    expect(parsed?.kind).toBe("inline");
    if (parsed?.kind === "inline") {
      expect(parsed.config.user).toBeUndefined();
      expect(parsed.config.host).toBe("server.example.com");
    }
  });

  it("parses an inline host", () => {
    const parsed = parseSshHostUri("ssh://bob@10.0.0.5:2222");
    expect(parsed?.kind).toBe("inline");
    if (parsed?.kind === "inline") {
      expect(parsed.config.user).toBe("bob");
      expect(parsed.config.host).toBe("10.0.0.5");
      expect(parsed.config.port).toBe(2222);
    }
  });

  it("parses an inline host with default port", () => {
    const parsed = parseSshHostUri("ssh://bob@server.example.com");
    expect(parsed?.kind).toBe("inline");
    if (parsed?.kind === "inline") {
      expect(parsed.config.port).toBe(DEFAULT_SSH_PORT);
    }
  });

  it("parses an IPv6 host", () => {
    const parsed = parseSshHostUri("ssh://bob@[::1]:2222");
    expect(parsed?.kind).toBe("inline");
    if (parsed?.kind === "inline") {
      expect(parsed.config.host).toBe("::1");
      expect(parsed.config.port).toBe(2222);
    }
  });

  it("parses an inline host with query overrides", () => {
    const parsed = parseSshHostUri(
      "ssh://bob@host?remoteHome=/data/p&installDir=/opt/p&version=1.0.0",
    );
    expect(parsed?.kind).toBe("inline");
    if (parsed?.kind === "inline") {
      expect(parsed.config.remoteHome).toBe("/data/p");
      expect(parsed.config.installDir).toBe("/opt/p");
      expect(parsed.config.packageVersion).toBe("1.0.0");
    }
  });

  it("returns null for non-ssh URIs", () => {
    expect(parseSshHostUri("tcp://localhost:6767")).toBeNull();
    expect(parseSshHostUri("https://example.com")).toBeNull();
  });

  it("returns null for malformed ssh URIs", () => {
    expect(parseSshHostUri("ssh://")).toBeNull();
    expect(parseSshHostUri("ssh://@host")?.kind).toBe("inline");
  });
});

describe("ssh-host-config: resolveSshHostConfig", () => {
  it("resolves an inline host", () => {
    const config = resolveSshHostConfig("ssh://carol@1.2.3.4");
    expect(config?.user).toBe("carol");
    expect(config?.host).toBe("1.2.3.4");
  });

  it("returns null for non-ssh URIs", () => {
    expect(resolveSshHostConfig("tcp://localhost:6767")).toBeNull();
  });
});
