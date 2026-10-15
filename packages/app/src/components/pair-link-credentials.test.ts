import { describe, expect, it } from "vitest";
import { PairingTargetTracker } from "./pair-link-credentials";

describe("pairing target password", () => {
  it("clears the password and hides its input when switching hosts", () => {
    const first = "relay://relay.example:443/srv_a?key=AAAA&ssl=true";
    const second = "relay://relay.example:443/srv_b?key=BBBB&ssl=true";
    const target = new PairingTargetTracker(first);
    expect(target.changeUrl("relay://relay.example:443/")).toBe(false);
    expect(target.changeUrl(second)).toBe(true);
    expect(target.changeUrl(second)).toBe(false);
  });

  it("clears the direct form credential when its advanced URI changes to a relay target", () => {
    const target = new PairingTargetTracker("", true);
    expect(target.changeUrl("relay://relay.example:443/srv_new?key=BBBB&ssl=true")).toBe(true);
  });

  it("keeps the password when a relay URI receives harmless whitespace", () => {
    const uri = "relay://relay.example:443/srv_a?key=AAAA&ssl=true";
    const target = new PairingTargetTracker(uri);
    expect(target.changeUrl(`${uri} `)).toBe(false);
  });

  it("recognizes a different host in an offer link after an incomplete edit", () => {
    const offer = Buffer.from(
      JSON.stringify({
        v: 2,
        serverId: "srv_b",
        daemonPublicKeyB64: "BBBB",
        relay: { endpoint: "relay.example:443" },
      }),
    ).toString("base64url");
    const target = new PairingTargetTracker("relay://relay.example:443/srv_a?key=AAAA");
    expect(target.changeUrl("https://app.paseo.sh/#offer=")).toBe(false);
    expect(target.changeUrl(`https://app.paseo.sh/#offer=${offer}`)).toBe(true);
  });
});
