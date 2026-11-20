import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
