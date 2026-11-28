import { describe, expect, it, vi } from "vitest";
import { relayConnectionFromOffer } from "@/types/host-connection";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import {
  connectionCertificateTarget,
  preparePairingCertificateWithApi,
} from "./pairing-client-certificate";

const connection = {
  id: "relay:wss:relay.example:443",
  type: "relay" as const,
  relayEndpoint: "relay.example:443",
  useTls: true,
  daemonPublicKeyB64: "AAAA",
};

describe("pairing client certificate", () => {
  it("selects for the relay in the offer, independently of the link's browser port", async () => {
    const encoded = Buffer.from(
      JSON.stringify({
        v: 2,
        serverId: "srv_a",
        daemonPublicKeyB64: "AAAA",
        relay: { endpoint: "relay.example:443", useTls: true },
      }),
    ).toString("base64url");
    const offer = parseConnectionOfferFromUrl(`https://relay.example:8444/#offer=${encoded}`)!;
    const certificates = {
      requiresCertificate: vi.fn(async () => true),
      choose: vi.fn(async () => "identity"),
    };
    expect(
      await preparePairingCertificateWithApi(relayConnectionFromOffer(offer), certificates),
    ).toBe(true);
    expect(certificates.requiresCertificate).toHaveBeenCalledWith("relay.example", 443);
    expect(certificates.choose).toHaveBeenCalledWith("relay.example", 443);
  });

  it("does not prompt when an existing identity works or the relay does not require one", async () => {
    const certificates = { requiresCertificate: vi.fn(async () => false), choose: vi.fn() };
    expect(await preparePairingCertificateWithApi(connection, certificates)).toBe(true);
    expect(certificates.choose).not.toHaveBeenCalled();
  });

  it("cancels pairing when the Android picker is cancelled", async () => {
    const certificates = {
      requiresCertificate: vi.fn(async () => true),
      choose: vi.fn(async () => null),
    };
    expect(await preparePairingCertificateWithApi(connection, certificates)).toBe(false);
  });

  it("skips plaintext and non-network transports and retains exact IPv6 ports", async () => {
    const certificates = { requiresCertificate: vi.fn(), choose: vi.fn() };
    expect(
      await preparePairingCertificateWithApi({ ...connection, useTls: false }, certificates),
    ).toBe(true);
    expect(
      await preparePairingCertificateWithApi(
        { id: "socket", type: "directSocket", path: "/tmp/daemon" },
        certificates,
      ),
    ).toBe(true);
    expect(certificates.requiresCertificate).not.toHaveBeenCalled();
    expect(
      connectionCertificateTarget({ ...connection, relayEndpoint: "[2001:db8::1]:9443" }),
    ).toEqual({ host: "2001:db8::1", port: 9443 });
  });
});
