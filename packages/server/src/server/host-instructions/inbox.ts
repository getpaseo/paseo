import { HostInstructionWorkspaceOverridesSchema } from "@getpaseo/protocol/messages";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { InstructionFileWriter, readInstructionFile } from "./storage.js";

const Id = z.string().min(1).max(256);
const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: Id }),
  z.object({ kind: z.literal("conversation"), workspaceId: Id, agentId: Id }),
]);
const Grant = z.object({
  id: z.uuid(),
  sourceId: Id,
  policy: z.enum(["ask", "unattended"]),
  workspaceOverrides: HostInstructionWorkspaceOverridesSchema.optional(),
  start: z.record(Id, Id),
  promptWorkspaces: z.array(Id),
  promptConversations: z.array(Id),
  excludedConversations: z.array(Id),
});
const StoredGrant = Grant.extend({ tokenDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export const HostInstructionSchema = z.object({
  id: z.uuid(),
  target: Target,
  prompt: z
    .string()
    .min(1)
    .max(32_768)
    .refine((text) => text.trim().length > 0),
  expiresAt: z.number().int().positive(),
});
export const HostInstructionStateSchema = z.enum([
  "awaiting_approval",
  "queued",
  "dispatching",
  "running",
  "completed",
  "failed",
  "denied",
  "cancelled",
  "expired",
  "revoked",
  "outcome_unknown",
]);
const RecordSchema = z.object({
  grantId: z.uuid(),
  sourceId: Id,
  instruction: HostInstructionSchema,
  fingerprint: z.string(),
  state: HostInstructionStateSchema,
  profileId: Id.optional(),
  approved: z.boolean().optional(),
  agentId: Id.optional(),
  messageId: z.uuid(),
  reply: z.string().max(32_768).optional(),
});
const InboxFile = z.object({
  grants: z.array(StoredGrant),
  requests: z.array(RecordSchema),
});

export const HOST_INSTRUCTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_GRANT = 100;

export type HostInstructionGrant = z.infer<typeof Grant>;
export type HostInstruction = z.infer<typeof HostInstructionSchema>;
export type InboxRequest = z.infer<typeof RecordSchema>;
type InboxData = z.infer<typeof InboxFile>;
type Principal = Pick<HostInstructionGrant, "id" | "sourceId">;

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function unstarted(state: InboxRequest["state"]): boolean {
  return state === "awaiting_approval" || state === "queued";
}

function targetPermission(grant: HostInstructionGrant, target: HostInstruction["target"]) {
  if (target.kind === "workspace") {
    return Object.hasOwn(grant.start, target.workspaceId) ? grant.start[target.workspaceId] : null;
  }
  return (
    !grant.excludedConversations.includes(target.agentId) &&
    (grant.workspaceOverrides !== undefined ||
      grant.promptConversations.includes(target.agentId) ||
      grant.promptWorkspaces.includes(target.workspaceId))
  );
}

/** Single-writer destination state. All decisions and their durable writes share one boundary. */
export class HostInstructionInbox {
  private constructor(
    private data: InboxData,
    private readonly writer: InstructionFileWriter,
    private readonly now: () => number,
  ) {}

  static async open(paseoHome: string, now: () => number = Date.now) {
    const file = path.join(paseoHome, "host-instructions", "inbox.json");
    const data = await readInstructionFile(file, InboxFile.parse, { grants: [], requests: [] });
    const inbox = new HostInstructionInbox(data, new InstructionFileWriter(file), now);
    let recovered = false;
    for (const request of data.requests) {
      if (request.state === "dispatching" || request.state === "running") {
        request.state = "outcome_unknown";
        recovered = true;
      }
    }
    if (recovered) await inbox.commit(data);
    await inbox.expire();
    return inbox;
  }

  async createGrant(input: Omit<HostInstructionGrant, "id">) {
    const grant = Grant.parse({ ...input, id: randomUUID() });
    const token = `${grant.id}.${randomBytes(32).toString("base64url")}`;
    const stored = { ...grant, tokenDigest: digestToken(token).toString("hex") };
    await this.commit({ ...this.data, grants: [...this.data.grants, stored] });
    return { ...structuredClone(grant), token };
  }

  async setHostPolicy(
    sourceId: string,
    policy: HostInstructionGrant["policy"],
    workspaceOverrides: NonNullable<HostInstructionGrant["workspaceOverrides"]>,
    prepare: () => Promise<void>,
  ) {
    await this.writer.settled();
    const current = this.hostGrant(sourceId);
    if (!current) {
      await prepare();
      if (this.hostGrant(sourceId)) throw new Error("Sending host already has a policy");
      return this.createGrant({
        sourceId,
        policy,
        workspaceOverrides,
        start: {},
        promptWorkspaces: [],
        promptConversations: [],
        excludedConversations: [],
      });
    }
    const updated = StoredGrant.parse({ ...current, policy, workspaceOverrides });
    await this.commit({
      ...this.data,
      grants: this.data.grants.map((grant) => (grant === current ? updated : grant)),
      requests: this.data.requests.map((request) => this.reconcilePolicy(request, updated)),
    });
    return null;
  }

  async canDiscover(principal: Principal, target: HostInstruction["target"]): Promise<boolean> {
    await this.writer.settled();
    return this.effectivePolicy(this.requireGrant(principal), target) !== "blocked";
  }

  private hostGrant(sourceId: string) {
    return this.data.grants.find(
      (grant) => grant.sourceId === sourceId && grant.workspaceOverrides !== undefined,
    );
  }

  private reconcilePolicy(request: InboxRequest, host: HostInstructionGrant): InboxRequest {
    if (request.sourceId !== host.sourceId || !unstarted(request.state)) return request;
    const grant = this.data.grants.find((entry) => entry.id === request.grantId);
    if (!grant) return request;
    const state = this.pendingState(request, grant, host);
    if (state === request.state || (request.state === "awaiting_approval" && state === "queued")) {
      return request;
    }
    return { ...request, state };
  }

  private effectivePolicy(
    grant: HostInstructionGrant,
    target: HostInstruction["target"],
    host: HostInstructionGrant = this.hostGrant(grant.sourceId) ?? grant,
  ) {
    if (!targetPermission(grant, target)) return "blocked";
    return (
      host.workspaceOverrides?.find((rule) => rule.workspaceId === target.workspaceId)?.policy ??
      host.policy
    );
  }

  async authenticate(token: string): Promise<Principal | null> {
    if (!/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
    await this.writer.settled();
    const grant = this.data.grants.find((entry) => entry.id === token.slice(0, 36));
    if (!grant || !timingSafeEqual(digestToken(token), Buffer.from(grant.tokenDigest, "hex"))) {
      return null;
    }
    return { id: grant.id, sourceId: grant.sourceId };
  }

  async listGrants(): Promise<HostInstructionGrant[]> {
    await this.writer.settled();
    return this.data.grants.map(({ tokenDigest: _secret, ...grant }) => structuredClone(grant));
  }

  async revoke(grantId: string, keepConversationGrants = false): Promise<void> {
    const host = this.data.grants.find(
      (grant) => grant.id === grantId && grant.workspaceOverrides !== undefined,
    );
    const revoked = new Set(
      this.data.grants
        .filter(
          (grant) =>
            grant.id === grantId ||
            (!keepConversationGrants && host && grant.sourceId === host.sourceId),
        )
        .map((grant) => grant.id),
    );
    await this.commit({
      grants: this.data.grants.filter((grant) => !revoked.has(grant.id)),
      requests: this.data.requests.map((request) =>
        revoked.has(request.grantId) && unstarted(request.state)
          ? { ...request, state: "revoked" }
          : request,
      ),
    });
  }

  async submit(principal: Principal, input: HostInstruction): Promise<InboxRequest> {
    return this.receive(principal, input, false);
  }

  async cancelDelivery(principal: Principal, input: HostInstruction) {
    await this.receive(principal, input, true);
    return this.status(principal, input.id);
  }

  private async receive(
    principal: Principal,
    input: HostInstruction,
    cancel: boolean,
  ): Promise<InboxRequest> {
    await this.expire();
    await this.writer.settled();
    const grant = this.requireGrant(principal);
    const instruction = HostInstructionSchema.parse(input);
    const fingerprint = createHash("sha256").update(JSON.stringify(instruction)).digest("hex");
    const existing = this.find(principal.sourceId, instruction.id);
    if (existing) {
      if (existing.grantId !== grant.id || existing.fingerprint !== fingerprint) {
        throw new Error("Instruction ID is already in use");
      }
      if (cancel && unstarted(existing.state)) return this.update(existing, { state: "cancelled" });
      return structuredClone(existing);
    }

    const permission = targetPermission(grant, instruction.target);
    const policy = this.effectivePolicy(grant, instruction.target);
    if (policy === "blocked") throw new Error("Instruction target is outside the grant");

    const remaining = instruction.expiresAt - this.now();
    if ((!cancel && remaining <= 0) || remaining > HOST_INSTRUCTION_TTL_MS) {
      throw new Error("Instruction expiry is outside the allowed window");
    }
    if (
      !cancel &&
      this.data.requests.filter(
        (request) => request.grantId === grant.id && unstarted(request.state),
      ).length >= MAX_PENDING_PER_GRANT
    ) {
      throw new Error("Too many pending instructions");
    }

    const initialState = policy === "ask" ? "awaiting_approval" : "queued";
    const request: InboxRequest = {
      grantId: grant.id,
      sourceId: grant.sourceId,
      instruction,
      fingerprint,
      approved: false,
      state: cancel ? "cancelled" : initialState,
      profileId: typeof permission === "string" ? permission : undefined,
      messageId: randomUUID(),
    };
    await this.commit({ ...this.data, requests: [...this.data.requests, request] });
    return structuredClone(request);
  }

  async status(principal: Principal, instructionId: string) {
    await this.expire();
    await this.writer.settled();
    this.requireGrant(principal);
    const request = this.find(principal.sourceId, instructionId);
    if (request?.grantId !== principal.id) return null;
    return { id: instructionId, state: request.state, reply: request.reply };
  }

  async cancel(principal: Principal, instructionId: string) {
    const status = await this.status(principal, instructionId);
    if (!status || !unstarted(status.state)) return status;
    const request = this.requireRequest(principal.sourceId, instructionId);
    if (unstarted(request.state)) await this.update(request, { state: "cancelled" });
    return this.status(principal, instructionId);
  }

  async decide(sourceId: string, instructionId: string, approve: boolean): Promise<InboxRequest> {
    await this.expire();
    const request = this.requireRequest(sourceId, instructionId);
    if (request.state !== "awaiting_approval")
      throw new Error("Instruction is not awaiting approval");
    const grant = this.requireGrant({ id: request.grantId, sourceId });
    if (this.effectivePolicy(grant, request.instruction.target) === "blocked") {
      return this.update(request, { state: "denied" });
    }
    return this.update(request, { approved: approve, state: approve ? "queued" : "denied" });
  }

  async list(): Promise<InboxRequest[]> {
    await this.expire();
    await this.writer.settled();
    return structuredClone(this.data.requests);
  }

  async claim(
    sourceId: string,
    instructionId: string,
    currentTarget: HostInstruction["target"] | null,
  ) {
    await this.expire();
    const request = this.requireRequest(sourceId, instructionId);
    if (request.state !== "queued") return null;
    const grant = this.requireGrant({ id: request.grantId, sourceId });
    const target = currentTarget === null ? null : Target.parse(currentTarget);
    if (
      !target ||
      JSON.stringify(target) !== JSON.stringify(request.instruction.target) ||
      !targetPermission(grant, target)
    ) {
      return this.update(request, { state: "failed" });
    }
    const state = this.pendingState(request, grant);
    if (state !== "queued") return this.update(request, { state });
    return this.update(request, {
      state: "dispatching",
      agentId: target.kind === "conversation" ? target.agentId : undefined,
    });
  }

  async markBusy(sourceId: string, instructionId: string): Promise<void> {
    const request = this.requireRequest(sourceId, instructionId);
    if (request.state !== "dispatching") throw new Error("Instruction has no dispatch claim");
    const grant = this.data.grants.find((entry) => entry.id === request.grantId);
    await this.update(request, { state: this.pendingState(request, grant) });
    await this.expire();
  }

  canDispatch(sourceId: string, instructionId: string): boolean {
    const request = this.find(sourceId, instructionId);
    return (
      request?.state === "dispatching" &&
      request.instruction.expiresAt > this.now() &&
      this.pendingState(
        request,
        this.data.grants.find((grant) => grant.id === request.grantId),
      ) === "queued"
    );
  }

  private pendingState(
    request: InboxRequest,
    grant: HostInstructionGrant | undefined,
    host?: HostInstructionGrant,
  ) {
    if (!grant) return "revoked";
    const policy = this.effectivePolicy(grant, request.instruction.target, host);
    if (policy === "blocked") return "denied";
    if (
      policy === "ask" &&
      !(
        request.approved ??
        (grant.workspaceOverrides === undefined &&
          !this.hostGrant(grant.sourceId) &&
          grant.policy === "ask")
      )
    )
      return "awaiting_approval";
    return "queued";
  }

  async markRunning(sourceId: string, instructionId: string, agentId: string): Promise<void> {
    const request = this.requireRequest(sourceId, instructionId);
    if (request.state !== "dispatching" || (request.agentId && request.agentId !== agentId)) {
      throw new Error("Instruction has no matching dispatch claim");
    }
    await this.update(request, { state: "running", agentId: Id.parse(agentId) });
  }

  async finish(
    sourceId: string,
    instructionId: string,
    state: "completed" | "failed" | "outcome_unknown",
  ) {
    const request = this.requireRequest(sourceId, instructionId);
    if (request.state !== "dispatching" && request.state !== "running") {
      throw new Error("Instruction has no active execution");
    }
    await this.update(request, { state });
  }

  async reply(
    sourceId: string,
    instructionId: string,
    agentId: string,
    text: string,
  ): Promise<void> {
    const request = this.requireRequest(sourceId, instructionId);
    if (request.state !== "running" || request.agentId !== agentId) {
      throw new Error("Reply is outside the originating execution");
    }
    const reply = HostInstructionSchema.shape.prompt.parse(text);
    if (request.reply === reply) return;
    if (request.reply !== undefined) throw new Error("Instruction already has a reply");
    await this.update(request, { reply });
  }

  private async expire(): Promise<void> {
    const now = this.now();
    if (
      !this.data.requests.some(
        (entry) => unstarted(entry.state) && entry.instruction.expiresAt <= now,
      )
    ) {
      return;
    }
    await this.commit({
      ...this.data,
      requests: this.data.requests.map((entry) =>
        unstarted(entry.state) && entry.instruction.expiresAt <= now
          ? { ...entry, state: "expired" }
          : entry,
      ),
    });
  }

  private requireGrant(principal: Principal): HostInstructionGrant {
    const grant = this.data.grants.find((entry) => entry.id === principal.id);
    if (!grant || grant.sourceId !== principal.sourceId)
      throw new Error("Instruction grant is invalid");
    return grant;
  }

  private find(sourceId: string, instructionId: string) {
    return this.data.requests.find(
      (entry) => entry.sourceId === sourceId && entry.instruction.id === instructionId,
    );
  }

  private requireRequest(sourceId: string, instructionId: string) {
    const request = this.find(sourceId, instructionId);
    if (!request) throw new Error("Instruction does not exist");
    return request;
  }

  private async update(
    request: InboxRequest,
    changes: Partial<InboxRequest>,
  ): Promise<InboxRequest> {
    const updated = { ...request, ...changes };
    await this.commit({
      ...this.data,
      requests: this.data.requests.map((entry) => (entry === request ? updated : entry)),
    });
    return structuredClone(updated);
  }

  private async commit(data: InboxData): Promise<void> {
    this.data = data;
    await this.writer.persist(data);
  }
}
