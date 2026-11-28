import { describe, expect, it, vi } from "vitest";
import type { ConnectionLinkImport, LinkPairing } from "@/runtime/host-runtime";
import { openPairingLinks, type OpenedLinkDependencies } from "./opened-link-model";

const LINK = "https://app.paseo.sh/#offer=abc";
const PAIRING: LinkPairing = { submit: async () => ({ status: "cancelled" }) };

type Snapshot = ReturnType<OpenedLinkDependencies["getSnapshot"]>;

/** The host runtime's side of an opened link: one saved host whose connection the test drives. */
function createOpenedLinks(outcome: ConnectionLinkImport | Error) {
  const imports: string[] = [];
  const imported: string[] = [];
  const hostListeners = new Set<() => void>();
  let snapshot: Snapshot = { connectionStatus: "connecting", authFailureReason: null };
  const links = openPairingLinks({
    importConnectionLink: async (link) => {
      imports.push(link);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    beginLinkPairing: () => PAIRING,
    getSnapshot: () => snapshot,
    subscribeToHost: (_serverId, listener) => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    },
    onImported: (serverId) => imported.push(serverId),
  });
  function hostBecomes(next: Snapshot): void {
    snapshot = next;
    for (const listener of hostListeners) {
      listener();
    }
  }
  return { links, imports, imported, hostBecomes, hostListeners };
}

async function hostSaved(target: { imported: string[] }): Promise<void> {
  await vi.waitFor(() => expect(target.imported).toHaveLength(1));
}

describe("openPairingLinks", () => {
  it("asks for the password when the saved host rejects its first connection for one", async () => {
    const opened = createOpenedLinks({ status: "connected", serverId: "srv_link" });

    opened.links.open(LINK);
    await hostSaved(opened);
    expect(opened.links.getState()).toEqual({ status: "idle" });

    opened.hostBecomes({ connectionStatus: "error", authFailureReason: "password_required" });
    await vi.waitFor(() =>
      expect(opened.links.getState()).toEqual({
        status: "passwordRequired",
        passwordRequired: { link: LINK, pairing: PAIRING },
      }),
    );
    expect(opened.hostListeners.size).toBe(0);
  });

  it("asks again for a saved host whose stored password is wrong", async () => {
    const opened = createOpenedLinks({ status: "connected", serverId: "srv_link" });
    opened.hostBecomes({ connectionStatus: "error", authFailureReason: "incorrect_password" });

    opened.links.open(LINK);

    await vi.waitFor(() => expect(opened.links.getState().status).toBe("passwordRequired"));
  });

  it("stays out of the way when the host connects, is offline, or is removed", async () => {
    for (const settledAs of [
      { connectionStatus: "online", authFailureReason: null },
      { connectionStatus: "offline", authFailureReason: null },
      { connectionStatus: "error", authFailureReason: null },
      null,
    ] satisfies Snapshot[]) {
      const opened = createOpenedLinks({ status: "connected", serverId: "srv_link" });
      opened.links.open(LINK);
      await hostSaved(opened);

      opened.hostBecomes(settledAs);
      await Promise.resolve();

      expect(opened.links.getState()).toEqual({ status: "idle" });
      expect(opened.hostListeners.size).toBe(0);
    }
  });

  it("returns to idle when the password prompt is closed, leaving the host saved", async () => {
    const opened = createOpenedLinks({ status: "connected", serverId: "srv_link" });
    opened.links.open(LINK);
    await hostSaved(opened);
    opened.hostBecomes({ connectionStatus: "error", authFailureReason: "password_required" });
    await vi.waitFor(() => expect(opened.links.getState().status).toBe("passwordRequired"));

    opened.links.closePassword();

    expect(opened.links.getState()).toEqual({ status: "idle" });
    expect(opened.imported).toEqual(["srv_link"]);
  });

  it("ignores URLs that are not pairing links, and cancelled or failed imports", async () => {
    const notALink = createOpenedLinks({ status: "connected", serverId: "srv_link" });
    notALink.links.open("https://app.paseo.sh/settings/general");
    notALink.links.open(null);
    await Promise.resolve();
    expect(notALink.imports).toEqual([]);

    for (const outcome of [{ status: "cancelled" } as const, new Error("Missing #offer=")]) {
      const opened = createOpenedLinks(outcome);
      opened.links.open(LINK);
      await vi.waitFor(() => expect(opened.imports).toEqual([LINK]));
      await Promise.resolve();
      expect(opened.imported).toEqual([]);
      expect(opened.links.getState()).toEqual({ status: "idle" });
    }
  });

  it("stops watching the host once closed", async () => {
    const opened = createOpenedLinks({ status: "connected", serverId: "srv_link" });
    opened.links.open(LINK);
    await hostSaved(opened);
    expect(opened.hostListeners.size).toBe(1);

    opened.links.close();
    opened.hostBecomes({ connectionStatus: "error", authFailureReason: "password_required" });

    expect(opened.hostListeners.size).toBe(0);
    expect(opened.links.getState()).toEqual({ status: "idle" });
  });
});
