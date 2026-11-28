import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privateFiles from "../private-files.js";
import { HostInstructionInbox } from "./inbox.js";
import { HostInstructionOutbox, type HostInstructionTransport } from "./outbox.js";

describe("host instruction outbox", () => {
  let home: string;
  let inbox: HostInstructionInbox;
  let outbox: HostInstructionOutbox;
  let transport: HostInstructionTransport;
  let online: boolean;
  let loseNextReceipt: boolean;

  const now = () => 100_000;
  const registration = "macbook";
  const request = {
    target: { kind: "conversation" as const, workspaceId: "checkout", agentId: "tester" },
    prompt: "Run the local build",
  };

  beforeEach(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "paseo-instruction-delivery-"));
    inbox = await HostInstructionInbox.open(path.join(home, "destination"), now);
    const grant = await inbox.createGrant({
      sourceId: "minibox",
      policy: "ask",
      start: {},
      promptWorkspaces: ["checkout"],
      promptConversations: [],
      excludedConversations: [],
    });
    online = false;
    loseNextReceipt = false;
    transport = {
      submit: async (_registration, instruction) => {
        if (!online) return null;
        await inbox.submit(grant, instruction);
        if (loseNextReceipt) {
          loseNextReceipt = false;
          return null;
        }
        return inbox.status(grant, instruction.id);
      },
      status: async (_registration, id) => (online ? inbox.status(grant, id) : null),
      cancel: async (_registration, instruction) =>
        online ? inbox.cancelDelivery(grant, instruction) : null,
    };
    outbox = await HostInstructionOutbox.open(path.join(home, "source"), transport, now);
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("retries after waking and restart with the original ID after a lost acknowledgment", async () => {
    const { id } = await outbox.submit(registration, request);
    await outbox.flush(registration);
    expect((await outbox.status(id)).state).toBe("waiting_for_host");
    expect(await inbox.list()).toHaveLength(0);

    online = true;
    loseNextReceipt = true;
    await outbox.flush(registration);
    expect((await outbox.status(id)).state).toBe("waiting_for_host");
    expect((await inbox.list())[0]?.instruction.id).toBe(id);

    outbox = await HostInstructionOutbox.open(path.join(home, "source"), transport, now);
    await outbox.flush(registration);
    expect((await outbox.status(id)).state).toBe("awaiting_approval");
    expect(await inbox.list()).toHaveLength(1);
    await inbox.decide("minibox", id, true);
    await outbox.flush(registration);
    expect((await outbox.status(id)).state).toBe("queued");
  });

  it("skips terminal history before looking up requests in a flush", async () => {
    for (let index = 0; index < 3; index++) {
      const old = await outbox.submit(registration, request);
      await outbox.cancel(old.id);
    }
    const pending = await outbox.submit(registration, request);
    const status = vi.spyOn(outbox, "status");
    try {
      online = true;
      await outbox.flush(registration);
      expect(status.mock.calls).toEqual([[pending.id]]);
    } finally {
      status.mockRestore();
    }
    expect((await outbox.status(pending.id)).state).toBe("awaiting_approval");
  });

  it("writes receipts only when the returned state or reply changes", async () => {
    const { id } = await outbox.submit(registration, request);
    online = true;
    await outbox.flush(registration);
    expect((await outbox.status(id)).state).toBe("awaiting_approval");

    const poll = vi.spyOn(transport, "status");
    const persist = vi.spyOn(privateFiles, "writePrivateFileAtomic");
    try {
      await outbox.flush(registration);
      await outbox.flush(registration);
      expect(poll).toHaveBeenCalledTimes(2);
      expect(persist).not.toHaveBeenCalled();

      poll.mockResolvedValue({ id, state: "running" });
      await outbox.flush(registration);
      expect(persist).toHaveBeenCalledTimes(1);

      poll.mockResolvedValue({ id, state: "running", reply: "Build passed" });
      await outbox.flush(registration);
      await outbox.flush(registration);
      expect(persist).toHaveBeenCalledTimes(2);
    } finally {
      persist.mockRestore();
      poll.mockRestore();
    }

    outbox = await HostInstructionOutbox.open(path.join(home, "source"), transport, now);
    expect(await outbox.status(id)).toMatchObject({ state: "running", reply: "Build passed" });
  });

  it("keeps delivering later requests after a rejected exchange", async () => {
    online = true;
    const rejected = await outbox.submit(registration, {
      ...request,
      target: { ...request.target, workspaceId: "outside-the-grant" },
    });
    const valid = await outbox.submit(registration, request);
    await outbox.flush(registration);
    expect((await outbox.status(rejected.id)).state).toBe("waiting_for_host");
    expect((await outbox.status(valid.id)).state).toBe("awaiting_approval");
  });

  it("persists offline cancellation and rejects a late submission at the destination", async () => {
    const { id } = await outbox.submit(registration, request);
    let lateSubmit: (() => Promise<unknown>) | undefined;
    const submit = transport.submit;
    transport.submit = async (destination, instruction) => {
      lateSubmit = () => submit(destination, instruction);
      return null;
    };

    await outbox.flush(registration);
    expect((await outbox.cancel(id)).cancellationPending).toBe(true);
    await outbox.flush(registration);
    outbox = await HostInstructionOutbox.open(path.join(home, "source"), transport, now);
    expect((await outbox.status(id)).cancellationPending).toBe(true);

    online = true;
    await outbox.flush(registration);
    expect(await lateSubmit?.()).toEqual({ id, state: "cancelled", reply: undefined });
    expect(await outbox.status(id)).toMatchObject({
      state: "cancelled",
      cancellationPending: false,
    });
    expect(await inbox.list()).toHaveLength(1);
  });

  it("does not report a local cancellation whose write failed", async () => {
    const initial = await outbox.submit(registration, request);
    const { id } = initial;
    const write = Promise.withResolvers<void>();
    const persist = vi
      .spyOn(privateFiles, "writePrivateFileAtomic")
      .mockReturnValueOnce(write.promise);
    // Resume cancel from its initial status check while the next read awaits the old write.
    const status = vi.spyOn(outbox, "status").mockResolvedValueOnce(initial);
    try {
      const cancellation = outbox.cancel(id);
      const receipts = Promise.allSettled([cancellation, outbox.status(id)]);
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
      write.reject(new Error("Could not persist cancellation"));
      expect((await receipts).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    } finally {
      status.mockRestore();
      persist.mockRestore();
    }

    outbox = await HostInstructionOutbox.open(path.join(home, "source"), transport, now);
    expect(await outbox.status(id)).toMatchObject({ state: "waiting_for_host" });
    expect(await outbox.cancel(id)).toMatchObject({
      state: "cancelled",
      cancellationPending: false,
    });
    outbox = await HostInstructionOutbox.open(path.join(home, "source"), transport, now);
    online = true;
    await outbox.flush(registration);
    expect(await inbox.list()).toEqual([]);
  });
});
