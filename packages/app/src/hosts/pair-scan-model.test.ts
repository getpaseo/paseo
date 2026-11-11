import { describe, expect, it, vi } from "vitest";
import type { ConnectionLinkImport, LinkPairing } from "@/runtime/host-runtime";
import { openPairScan, type PairScanModel } from "./pair-scan-model";

const LINK = "https://app.paseo.sh/#offer=abc";
const PAIRING: LinkPairing = { submit: async () => ({ status: "cancelled" }) };

/** The host runtime's side of a scan: each import resolves with the next queued outcome. */
function createScanner(outcomes: Array<ConnectionLinkImport | Error>) {
  const imports: string[] = [];
  const connected: string[] = [];
  const scan = openPairScan({
    importConnectionLink: async (link) => {
      imports.push(link);
      const outcome = outcomes.shift();
      if (!outcome) throw new Error("No outcome queued for this import");
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    onConnected: (serverId) => connected.push(serverId),
  });
  return { scan, imports, connected };
}

async function settled(scan: PairScanModel): Promise<void> {
  await vi.waitFor(() => expect(scan.getState().status).not.toBe("pairing"));
}

describe("openPairScan", () => {
  it("stops scanning after Cancel until the user scans again", async () => {
    const { scan, imports } = createScanner([{ status: "cancelled" }, { status: "cancelled" }]);

    scan.scan(LINK);
    await settled(scan);

    // The code is still in front of the camera.
    scan.scan(LINK);
    scan.scan(LINK);
    await Promise.resolve();
    expect(imports).toEqual([LINK]);
    expect(scan.getState()).toEqual({ status: "stopped", error: null });

    scan.scanAgain();
    scan.scan(LINK);
    await settled(scan);
    expect(imports).toEqual([LINK, LINK]);
  });

  it("starts one attempt per code while pairing, and ignores codes that are not pairing links", async () => {
    const { scan, imports, connected } = createScanner([
      { status: "connected", serverId: "srv_scan" },
    ]);

    scan.scan("https://example.com/not-a-pairing-link");
    expect(scan.getState()).toEqual({ status: "scanning" });

    scan.scan(LINK);
    scan.scan(LINK);
    await settled(scan);

    expect(imports).toEqual([LINK]);
    expect(connected).toEqual(["srv_scan"]);
    scan.scan(LINK);
    expect(imports).toEqual([LINK]);
  });

  it("ends the attempt when the password prompt closes", async () => {
    const { scan, imports } = createScanner([
      { status: "password_required", link: LINK, pairing: PAIRING },
    ]);

    scan.scan(LINK);
    await settled(scan);
    expect(scan.getState()).toEqual({
      status: "passwordRequired",
      passwordRequired: { link: LINK, pairing: PAIRING },
    });
    scan.scan(LINK);

    scan.closePassword();
    scan.scan(LINK);

    expect(scan.getState()).toEqual({ status: "stopped", error: null });
    expect(imports).toEqual([LINK]);
  });

  it("stops with the error when an attempt fails", async () => {
    const { scan, imports } = createScanner([new Error("Server disconnected")]);

    scan.scan(LINK);
    await settled(scan);
    scan.scan(LINK);

    expect(scan.getState()).toEqual({ status: "stopped", error: "Server disconnected" });
    expect(imports).toEqual([LINK]);
  });

  it("does not navigate for an attempt that finishes after the screen closed", async () => {
    let finish: (outcome: ConnectionLinkImport) => void = () => {};
    const connected: string[] = [];
    const scan = openPairScan({
      importConnectionLink: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      onConnected: (serverId) => connected.push(serverId),
    });

    scan.scan(LINK);
    scan.close();
    finish({ status: "connected", serverId: "srv_scan" });
    await Promise.resolve();

    expect(connected).toEqual([]);
  });
});
