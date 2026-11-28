import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privateFiles from "../private-files.js";
import { HOST_INSTRUCTION_TTL_MS, HostInstructionInbox, type HostInstruction } from "./inbox.js";

describe("host instruction inbox", () => {
  let home: string;
  let now: number;
  let inbox: HostInstructionInbox;
  let instruction: HostInstruction;

  const grantConfig = {
    sourceId: "worker",
    policy: "ask" as const,
    start: { workspace: "local-profile" },
    promptWorkspaces: ["workspace"],
    promptConversations: ["exception"],
    excludedConversations: ["excluded"],
  };

  beforeEach(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "paseo-instruction-test-"));
    now = 100_000;
    inbox = await HostInstructionInbox.open(home, () => now);
    instruction = {
      id: randomUUID(),
      target: { kind: "workspace", workspaceId: "workspace" },
      prompt: "Run tests",
      expiresAt: now + HOST_INSTRUCTION_TTL_MS,
    };
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("authenticates a scoped source across restart and invalidates it on revocation", async () => {
    const grant = await inbox.createGrant(grantConfig);
    const storage = readFileSync(path.join(home, "host-instructions", "inbox.json"), "utf8");
    expect(storage).not.toContain(grant.token);
    inbox = await HostInstructionInbox.open(home, () => now);
    expect(await inbox.authenticate(grant.token)).toEqual({ id: grant.id, sourceId: "worker" });
    expect(await inbox.authenticate(`${grant.id}.${"a".repeat(43)}`)).toBeNull();
    await inbox.revoke(grant.id);
    expect(await inbox.authenticate(grant.token)).toBeNull();
  });

  it("persists approval and deduplicates delivery without changing the local profile", async () => {
    const grant = await inbox.createGrant(grantConfig);
    const [original, duplicate] = await Promise.all([
      inbox.submit(grant, instruction),
      inbox.submit(grant, instruction),
    ]);
    expect(duplicate).toEqual(original);
    expect(await inbox.list()).toHaveLength(1);
    expect(original).toMatchObject({ state: "awaiting_approval", profileId: "local-profile" });
    expect(await inbox.claim(grant.sourceId, instruction.id, instruction.target)).toBeNull();
    await inbox.decide(grant.sourceId, instruction.id, true);
    inbox = await HostInstructionInbox.open(home, () => now);

    expect(await inbox.submit(grant, instruction)).toMatchObject({
      state: "queued",
      messageId: original.messageId,
    });
    await expect(inbox.submit(grant, { ...instruction, prompt: "Different" })).rejects.toThrow(
      "already in use",
    );
    if (process.platform !== "win32") {
      expect(statSync(path.join(home, "host-instructions", "inbox.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("does not acknowledge either concurrent delivery when its write fails", async () => {
    const grant = await inbox.createGrant(grantConfig);
    const write = Promise.withResolvers<void>();
    const persist = vi
      .spyOn(privateFiles, "writePrivateFileAtomic")
      .mockReturnValueOnce(write.promise);
    try {
      const delivered = Promise.allSettled([
        inbox.submit(grant, instruction),
        inbox.submit(grant, instruction),
      ]);
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
      write.reject(new Error("Could not persist instruction"));
      expect((await delivered).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(await (await HostInstructionInbox.open(home, () => now)).list()).toEqual([]);
    } finally {
      persist.mockRestore();
    }
  });

  it("accepts bounded clock skew and returns saved receipts after a target becomes unavailable", async () => {
    const grant = await inbox.createGrant({ ...grantConfig, policy: "unattended" });
    const skewed = { ...instruction, expiresAt: instruction.expiresAt + 60_000 };
    await inbox.submit(grant, skewed, async () => true);
    await inbox.claim(grant.sourceId, skewed.id, skewed.target);
    await inbox.finish(grant.sourceId, skewed.id, "completed");
    const unavailable = vi.fn(async () => false);
    expect((await inbox.submit(grant, skewed, unavailable)).state).toBe("completed");
    expect(unavailable).not.toHaveBeenCalled();
    await expect(
      inbox.submit(grant, { ...skewed, prompt: "Different" }, unavailable),
    ).rejects.toThrow("already in use");
    await expect(
      inbox.submit(grant, {
        ...skewed,
        id: randomUUID(),
        expiresAt: instruction.expiresAt + 360_000,
      }),
    ).rejects.toThrow("expiry is outside");
  });

  it("does not report a concurrent cancellation until its snapshot is durable", async () => {
    const grant = await inbox.createGrant({ ...grantConfig, policy: "unattended" });
    await inbox.submit(grant, instruction);
    const write = Promise.withResolvers<void>();
    const persist = vi
      .spyOn(privateFiles, "writePrivateFileAtomic")
      .mockReturnValueOnce(write.promise);
    try {
      const cancellation = inbox.cancelDelivery(grant, instruction);
      const status = inbox.status(grant, instruction.id);
      const receipts = Promise.allSettled([cancellation, status]);
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
      write.reject(new Error("Could not persist cancellation"));
      expect((await receipts).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      const restarted = await HostInstructionInbox.open(home, () => now);
      expect(await restarted.status(grant, instruction.id)).toMatchObject({ state: "queued" });
    } finally {
      persist.mockRestore();
    }
  });

  it("enforces source identity, conversation exceptions, and workspace scope", async () => {
    const grant = await inbox.createGrant({ ...grantConfig, policy: "unattended" });
    await expect(inbox.submit({ ...grant, sourceId: "stranger" }, instruction)).rejects.toThrow(
      "invalid",
    );
    for (const [workspaceId, agentId] of [
      ["workspace", "excluded"],
      ["other", "unknown"],
    ]) {
      await expect(
        inbox.submit(grant, {
          ...instruction,
          target: { kind: "conversation", workspaceId, agentId },
        }),
      ).rejects.toThrow("outside the grant");
    }
    expect(
      (
        await inbox.submit(grant, {
          ...instruction,
          target: { kind: "conversation", workspaceId: "other", agentId: "exception" },
        })
      ).state,
    ).toBe("queued");
  });

  it("reissues a legacy policy credential without invalidating accepted requests", async () => {
    const grant = await inbox.createGrant({ ...grantConfig, workspaceOverrides: [] });
    const admitted = await inbox.submit(grant, {
      ...instruction,
      target: { kind: "conversation", workspaceId: "workspace", agentId: "recipient" },
    });
    const recover = async () => (id: string) => `${id}.${"b".repeat(43)}`;
    const recovered = await inbox.setHostPolicy(grant.sourceId, "ask", [], recover, true);
    if (!recovered) throw new Error("Expected recovered registration");
    expect(recovered.id).toBe(grant.id);
    expect(await inbox.authenticate(grant.token)).toBeNull();
    const principal = await inbox.authenticate(recovered.token);
    if (!principal) throw new Error("Recovered registration was refused");
    expect(await inbox.submit(principal, admitted.instruction)).toEqual(admitted);
  });

  it("uses the host default and tightens queued instructions when a workspace rule changes", async () => {
    const prepare = async () => (id: string) => `${id}.${"a".repeat(43)}`;
    const grant = await inbox.setHostPolicy(
      "worker",
      "unattended",
      [
        { workspaceId: "protected", policy: "ask" },
        { workspaceId: "blocked", policy: "blocked" },
      ],
      prepare,
    );
    if (!grant) throw new Error("Expected a new host policy");
    const task = (workspaceId: string): HostInstruction => ({
      ...instruction,
      id: randomUUID(),
      target: { kind: "conversation", workspaceId, agentId: "recipient" },
    });
    const normal = task("workspace");
    expect((await inbox.submit(grant, normal)).state).toBe("queued");
    expect((await inbox.submit(grant, task("protected"))).state).toBe("awaiting_approval");
    await expect(inbox.submit(grant, task("blocked"))).rejects.toThrow("outside the grant");

    expect(await inbox.setHostPolicy("worker", "ask", [], prepare)).toBeNull();
    expect(await inbox.authenticate(grant.token)).toEqual({ id: grant.id, sourceId: "worker" });
    inbox = await HostInstructionInbox.open(home, () => now);
    const recovered = await inbox.setHostPolicy("worker", "ask", [], prepare, true);
    expect(recovered).toEqual({ id: grant.id, token: grant.token });
    expect((await inbox.status(grant, normal.id))?.state).toBe("awaiting_approval");
    await inbox.decide("worker", normal.id, true);
    expect((await inbox.claim("worker", normal.id, normal.target))?.state).toBe("dispatching");

    await inbox.setHostPolicy(
      "worker",
      "ask",
      [{ workspaceId: "workspace", policy: "blocked" }],
      prepare,
    );
    expect(inbox.canDispatch("worker", normal.id)).toBe(false);
    await inbox.markBusy("worker", normal.id);
    expect((await inbox.status(grant, normal.id))?.state).toBe("denied");
  });

  it("moves a busy claim back to the queue and blocks dispatch after revocation", async () => {
    const grant = await inbox.createGrant({ ...grantConfig, policy: "unattended" });
    await inbox.submit(grant, instruction);
    expect((await inbox.claim(grant.sourceId, instruction.id, instruction.target))?.state).toBe(
      "dispatching",
    );
    await inbox.markBusy(grant.sourceId, instruction.id);
    expect((await inbox.status(grant, instruction.id))?.state).toBe("queued");
    await inbox.claim(grant.sourceId, instruction.id, instruction.target);

    expect(inbox.canDispatch(grant.sourceId, instruction.id)).toBe(true);
    await inbox.revoke(grant.id);
    expect(inbox.canDispatch(grant.sourceId, instruction.id)).toBe(false);
    await inbox.markBusy(grant.sourceId, instruction.id);
    expect((await inbox.list())[0]?.state).toBe("revoked");
  });

  it("keeps a dispatching claim when the runtime cannot withdraw it", async () => {
    const grant = await inbox.createGrant({ ...grantConfig, policy: "unattended" });
    const delivery = {
      ...instruction,
      target: { kind: "conversation" as const, workspaceId: "workspace", agentId: "exception" },
    };
    await inbox.submit(grant, delivery);
    await inbox.claim(grant.sourceId, delivery.id, delivery.target);

    await expect(inbox.cancelDelivery(grant, delivery, () => false)).resolves.toMatchObject({
      id: delivery.id,
      state: "dispatching",
    });
    await inbox.markRunning(grant.sourceId, delivery.id, delivery.target.agentId);
    await expect(inbox.cancelDelivery(grant, delivery, () => true)).resolves.toMatchObject({
      id: delivery.id,
      state: "running",
    });
  });

  it("holds pre-Stop instructions across restart until a new turn", async () => {
    const grant = await inbox.createGrant({ ...grantConfig, policy: "unattended" });
    const target = {
      kind: "conversation" as const,
      workspaceId: "workspace",
      agentId: "exception",
    };
    const claimed = { ...instruction, target };
    const queued = { ...claimed, id: randomUUID() };
    await inbox.submit(grant, claimed);
    await inbox.submit(grant, queued);
    await inbox.claim(grant.sourceId, claimed.id, target);

    await inbox.setStopHold(target.agentId, true, { sourceId: grant.sourceId, id: claimed.id });
    expect(inbox.canDispatch(grant.sourceId, claimed.id)).toBe(false);
    inbox = await HostInstructionInbox.open(home, () => now);
    expect(await inbox.claim(grant.sourceId, claimed.id, target)).toBeNull();
    expect(await inbox.claim(grant.sourceId, queued.id, target)).toBeNull();
    expect(await inbox.status(grant, queued.id)).toMatchObject({ state: "queued" });

    const newer = { ...claimed, id: randomUUID() };
    await inbox.submit(grant, newer);
    expect(await inbox.claim(grant.sourceId, newer.id, target)).toMatchObject({
      state: "dispatching",
    });
    await inbox.setStopHold(target.agentId, false);
    expect(await inbox.claim(grant.sourceId, claimed.id, target)).toMatchObject({
      state: "dispatching",
    });
    expect(await inbox.claim(grant.sourceId, queued.id, target)).toMatchObject({
      state: "dispatching",
    });
  });

  it("expires queued work after restart and never replays an ambiguous dispatch", async () => {
    const grant = await inbox.createGrant({ ...grantConfig, policy: "unattended" });
    const waiting = { ...instruction, id: randomUUID() };
    await inbox.submit(grant, instruction);
    await inbox.submit(grant, waiting);
    await inbox.claim(grant.sourceId, instruction.id, instruction.target);
    now = waiting.expiresAt;
    inbox = await HostInstructionInbox.open(home, () => now);

    expect((await inbox.status(grant, waiting.id))?.state).toBe("expired");
    expect((await inbox.status(grant, instruction.id))?.state).toBe("outcome_unknown");
    expect(await inbox.claim(grant.sourceId, instruction.id, instruction.target)).toBeNull();
  });

  it("isolates status and replies to their originating request", async () => {
    const grant = await inbox.createGrant({ ...grantConfig, policy: "unattended" });
    const other = await inbox.createGrant({ ...grantConfig, sourceId: "desktop" });
    await inbox.submit(grant, instruction);
    await inbox.claim(grant.sourceId, instruction.id, instruction.target);
    await inbox.markRunning(grant.sourceId, instruction.id, "recipient");
    await expect(inbox.reply(grant.sourceId, instruction.id, "stranger", "Result")).rejects.toThrow(
      "outside the originating execution",
    );
    await inbox.reply(grant.sourceId, instruction.id, "recipient", "Result");
    await inbox.finish(grant.sourceId, instruction.id, "completed");

    expect(await inbox.status(other, instruction.id)).toBeNull();
    expect(await inbox.status(grant, instruction.id)).toEqual({
      id: instruction.id,
      state: "completed",
      reply: "Result",
    });
  });

  it("rejects both concurrent reply acknowledgments if their write fails", async () => {
    const grant = await inbox.createGrant({ ...grantConfig, policy: "unattended" });
    await inbox.submit(grant, instruction);
    await inbox.claim(grant.sourceId, instruction.id, instruction.target);
    await inbox.markRunning(grant.sourceId, instruction.id, "recipient");

    const write = Promise.withResolvers<void>();
    const persist = vi
      .spyOn(privateFiles, "writePrivateFileAtomic")
      .mockReturnValueOnce(write.promise);
    try {
      const sendReply = () => inbox.reply(grant.sourceId, instruction.id, "recipient", "Result");
      const acknowledgments = Promise.allSettled([sendReply(), sendReply()]);
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
      write.reject(new Error("Could not persist reply"));
      expect((await acknowledgments).map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      const restarted = await HostInstructionInbox.open(home, () => now);
      expect(await restarted.status(grant, instruction.id)).toEqual({
        id: instruction.id,
        state: "outcome_unknown",
        reply: undefined,
      });
    } finally {
      persist.mockRestore();
    }
  });
});
