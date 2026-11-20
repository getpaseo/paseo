import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("uses the host default and tightens queued instructions when a workspace rule changes", async () => {
    const prepare = async () => {};
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
});
