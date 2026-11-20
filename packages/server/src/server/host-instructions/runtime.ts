import { randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHostTransportFactory, parseHostTarget } from "@getpaseo/client/node";
import type {
  HostInstructionsCommand,
  HostInstructionsResponseSchema,
} from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentManager } from "../agent/agent-manager.js";
import {
  AgentTurnBusyError,
  sendPreparedPromptToAgent,
  waitForAgentRunStartWithTimeout,
} from "../agent/agent-prompt.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { createConnectionOfferV2, encodeOfferToFragmentUrl } from "../connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "../daemon-keypair.js";
import {
  createRelayRuntime,
  type RelayRuntime,
  type RelayRuntimeConfig,
} from "../relay-runtime.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { admitSecuredRelaySocket } from "../websocket/secure-relay-ingress.js";
import { HostInstructionInbox, HostInstructionSchema } from "./inbox.js";
import { HostInstructionOutbox, HostInstructionReceiptSchema } from "./outbox.js";
import { InstructionFileWriter, readInstructionFile } from "./storage.js";

const Registration = z.object({
  destinationId: z.string(),
  offer: z.string(),
  token: z.string(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
});
type Registration = z.infer<typeof Registration>;
type ManagementResult = Omit<
  z.infer<typeof HostInstructionsResponseSchema>["payload"],
  "requestId"
>;

const ConversationTarget = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string().optional(),
  title: z.string().optional(),
});
type ConversationTarget = z.infer<typeof ConversationTarget>;
const Request = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("submit"), instruction: HostInstructionSchema }),
  z.object({ action: z.literal("cancel"), instruction: HostInstructionSchema }),
  z.object({ action: z.literal("status"), id: z.uuid(), expiresAt: z.number().int().positive() }),
]);
type Request = z.infer<typeof Request>;

const Frame = z.object({ token: z.string().max(128), request: Request });
const Reply = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    receipt: HostInstructionReceiptSchema.nullable(),
    targets: z.array(ConversationTarget).optional(),
  }),
  z.object({ ok: z.literal(false), state: z.enum(["failed", "revoked"]) }),
]);

function registrationKey(registration: Registration): string {
  return registration.token.slice(0, 36);
}

interface RuntimeOptions {
  paseoHome: string;
  serverId: string;
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceRegistry: WorkspaceRegistry;
  relay: () => RelayRuntimeConfig;
}

export class HostInstructionsRuntime {
  private relay: RelayRuntime | undefined;
  private relayOffer: Promise<string> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly active = new Set<string>();
  private readonly discoveredTargets = new Map<string, ConversationTarget[]>();
  private busy = false;
  private stopped = false;

  private constructor(
    private readonly options: RuntimeOptions,
    private readonly inbox: HostInstructionInbox,
    private readonly registrations: Map<string, Registration>,
    private readonly registrationWriter: InstructionFileWriter,
    readonly outbox: HostInstructionOutbox,
  ) {
    this.timer = setInterval(() => {
      void this.tick().catch(() => options.logger.warn("host_instruction_tick_failed"));
    }, 3000);
    this.timer.unref();
  }

  static async open(options: RuntimeOptions) {
    const file = path.join(options.paseoHome, "host-instructions", "registrations.json");
    const saved = await readInstructionFile(file, z.array(Registration).parse, []);
    const registrations = new Map(saved.map((entry) => [registrationKey(entry), entry]));
    const inbox = await HostInstructionInbox.open(options.paseoHome);
    const outbox = await HostInstructionOutbox.open(options.paseoHome, {
      submit: (key, instruction) =>
        exchange(registrations.get(key), { action: "submit", instruction }),
      cancel: (key, instruction) =>
        exchange(registrations.get(key), { action: "cancel", instruction }),
      status: (key, id, expiresAt) =>
        exchange(registrations.get(key), { action: "status", id, expiresAt }),
    });
    return new HostInstructionsRuntime(
      options,
      inbox,
      registrations,
      new InstructionFileWriter(file),
      outbox,
    );
  }

  async manage(command: HostInstructionsCommand): Promise<ManagementResult> {
    switch (command.action) {
      case "list": {
        const grants = await this.inbox.listGrants();
        const requests = await this.inbox.list();
        return {
          hostPolicies: grants.flatMap(({ id, sourceId, policy, workspaceOverrides }) =>
            workspaceOverrides ? [{ id, sourceId, policy, workspaceOverrides }] : [],
          ),
          grants: grants.flatMap((grant) =>
            grant.promptConversations.map((agentId) => ({
              id: grant.id,
              sourceId: grant.sourceId,
              agentId,
              policy: grant.policy,
            })),
          ),
          requests: requests.flatMap(({ sourceId, state, instruction }) =>
            state === "awaiting_approval" && instruction.target.kind === "conversation"
              ? [
                  {
                    id: instruction.id,
                    sourceId,
                    agentId: instruction.target.agentId,
                    workspaceId: instruction.target.workspaceId,
                    prompt: instruction.prompt,
                  },
                ]
              : [],
          ),
        };
      }
      case "set_policy": {
        if (command.sourceId === this.options.serverId) throw new Error("Choose another host");
        const ids = new Set(command.workspaceOverrides.map((rule) => rule.workspaceId));
        if (ids.size !== command.workspaceOverrides.length)
          throw new Error("Duplicate workspace override");
        const grant = await this.inbox.setHostPolicy(
          command.sourceId,
          command.policy,
          command.workspaceOverrides,
          async () => {
            await this.getRelayOffer();
          },
        );
        if (!grant) return {};
        return {
          registration: { id: grant.id, offer: await this.getRelayOffer(), token: grant.token },
        };
      }
      case "grant": {
        if (command.sourceId === this.options.serverId) throw new Error("Choose another host");
        const target = await this.resolveConversation(command.agentId);
        if (!target) throw new Error("Choose an active workspace conversation");
        const offer = await this.getRelayOffer();
        const grant = await this.inbox.createGrant({
          sourceId: command.sourceId,
          policy: command.policy,
          start: {},
          promptWorkspaces: [],
          promptConversations: [target.agentId],
          excludedConversations: [],
        });
        return {
          registration: {
            id: grant.id,
            offer,
            token: grant.token,
            workspaceId: target.workspaceId,
          },
        };
      }
      case "register": {
        if (command.destinationId === this.options.serverId) throw new Error("Choose another host");
        const target = parseHostTarget(command.offer);
        if (target.kind !== "socket" || target.offer?.minimumSecurityMode !== "protected") {
          throw new Error("Host instructions require a protected relay offer");
        }
        if (Boolean(command.agentId) !== Boolean(command.workspaceId)) {
          throw new Error(
            "A conversation registration requires both the conversation and workspace IDs",
          );
        }
        const registration = Registration.parse(command);
        this.registrations.set(registrationKey(registration), registration);
        await this.registrationWriter.persist([...this.registrations.values()]);
        return {};
      }
      case "decide":
        await this.inbox.decide(command.sourceId, command.id, command.approve);
        this.options.logger.info(
          { requestId: command.id, sourceId: command.sourceId, approved: command.approve },
          "host_instruction_decided",
        );
        return {};
      case "revoke":
        await this.inbox.revoke(command.id, command.keepConversationGrants);
        return {};
    }
  }

  async listDestinations() {
    const registrations = [...this.registrations.values()];
    const hostPolicies = new Set(
      registrations
        .filter((registration) => !registration.agentId)
        .map((registration) => registration.destinationId),
    );
    const entries = await Promise.all(
      registrations
        .filter((entry) => !entry.agentId || !hostPolicies.has(entry.destinationId))
        .map(async (entry) => {
          let targets: ConversationTarget[];
          if (entry.agentId && entry.workspaceId) {
            targets = [{ agentId: entry.agentId, workspaceId: entry.workspaceId }];
          } else {
            targets = await this.discover(entry);
          }
          return targets.map((target) =>
            Object.assign({ destinationId: entry.destinationId }, target),
          );
        }),
    );
    const unique = new Map(
      entries.flat().map((entry) => [JSON.stringify([entry.destinationId, entry.agentId]), entry]),
    );
    return [...unique.values()];
  }

  private async discover(entry: Registration) {
    const key = registrationKey(entry);
    const result = await exchangeFrame(entry, { action: "list" });
    if (result) this.discoveredTargets.set(key, result.ok ? (result.targets ?? []) : []);
    return this.discoveredTargets.get(key) ?? [];
  }

  async submit(destinationId: string, agentId: string, prompt: string, workspaceId?: string) {
    await this.registrationWriter.settled();
    const entries = [...this.registrations.values()].filter(
      (registration) => registration.destinationId === destinationId,
    );
    const entry =
      entries.findLast((registration) => !registration.agentId) ??
      entries.findLast((registration) => registration.agentId === agentId);
    if (!entry) throw new Error("This conversation has no instruction grant");
    const targetWorkspace =
      entry.workspaceId ??
      workspaceId ??
      (await this.discover(entry)).find((target) => target.agentId === agentId)?.workspaceId;
    if (!targetWorkspace)
      throw new Error(
        "Conversation unavailable. List instruction targets first or pass its workspace ID",
      );
    return this.outbox.submit(registrationKey(entry), {
      target: { kind: "conversation", workspaceId: targetWorkspace, agentId },
      prompt,
    });
  }

  async reply(agentId: string, sourceId: string, id: string, text: string) {
    await this.inbox.reply(sourceId, id, agentId, text);
    return { id };
  }

  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.relay?.stop();
  }

  private async getRelayOffer(): Promise<string> {
    const config = this.options.relay();
    if (!config.enabled) throw new Error("Enable relay on the receiving host first");
    this.relayOffer ??= this.startRelay(config).catch((error: unknown) => {
      this.relayOffer = undefined;
      throw error;
    });
    return this.relayOffer;
  }

  private async startRelay(config: RelayRuntimeConfig) {
    const home = path.join(this.options.paseoHome, "host-instructions");
    const key = await loadOrCreateDaemonKeyPair(home, this.options.logger);
    const identityFile = path.join(home, "relay-id.json");
    const savedId = await readInstructionFile(identityFile, z.string().nullable().parse, null);
    const routeId = savedId ?? `srv_${randomBytes(9).toString("base64url")}`;
    if (!savedId) await new InstructionFileWriter(identityFile).persist(routeId);
    const offer = await createConnectionOfferV2({
      serverId: routeId,
      daemonPublicKeyB64: key.publicKeyB64,
      relay: { endpoint: config.publicEndpoint, useTls: config.publicUseTls },
      minimumSecurityMode: "protected",
    });
    if (this.stopped) throw new Error("Host instructions stopped");
    this.relay = createRelayRuntime({
      config,
      logger: this.options.logger,
      serverId: routeId,
      attachSocket: (socket) =>
        admitSecuredRelaySocket(
          socket,
          {
            daemonKeyPair: key.keyPair,
            requireProtectedMode: () => true,
            logger: this.options.logger,
          },
          async ({ socket: secured }) => {
            let received = false;
            const timer = setTimeout(() => secured.terminate(), 8000);
            timer.unref();
            secured.once("close", () => clearTimeout(timer));
            secured.on("error", () => secured.terminate());
            secured.on("message", (value) => {
              if (received) return;
              received = true;
              void this.receive(value)
                .then(
                  async (reply) => {
                    await secured.send(JSON.stringify(reply));
                    return secured.close();
                  },
                  () => secured.close(1008, "Invalid instruction"),
                )
                .catch(() => secured.terminate());
            });
          },
        ),
    });
    return encodeOfferToFragmentUrl({ offer, appBaseUrl: "https://app.paseo.sh" });
  }

  private async receive(value: unknown): Promise<z.infer<typeof Reply>> {
    if (
      typeof value !== "string" ||
      value.length > 200_000 ||
      this.stopped ||
      !this.options.relay().enabled
    ) {
      throw new Error("Instruction channel is unavailable");
    }
    const { token, request } = Frame.parse(JSON.parse(value));
    const principal = await this.inbox.authenticate(token);
    if (!principal) return { ok: false, state: "revoked" };
    try {
      if (request.action === "list") {
        return { ok: true, receipt: null, targets: await this.getSharedTargets(principal) };
      }
      if (request.action === "status") {
        const receipt = await this.inbox.status(principal, request.id);
        if (!receipt && request.expiresAt <= Date.now()) {
          return { ok: true, receipt: { id: request.id, state: "expired" } };
        }
        return { ok: true, receipt };
      }
      if (request.action === "cancel") {
        return {
          ok: true,
          receipt: await this.inbox.cancelDelivery(principal, request.instruction),
        };
      }
      const target = request.instruction.target;
      if (target.kind !== "conversation") return { ok: false, state: "failed" };
      // A sender may provide a workspace ID, but the destination owns conversation placement.
      const current = await this.resolveConversation(target.agentId);
      if (current?.workspaceId !== target.workspaceId) return { ok: false, state: "failed" };
      await this.inbox.submit(principal, request.instruction);
      return { ok: true, receipt: await this.inbox.status(principal, request.instruction.id) };
    } catch {
      return { ok: false, state: "failed" };
    }
  }

  private async getSharedTargets(
    principal: NonNullable<Awaited<ReturnType<HostInstructionInbox["authenticate"]>>>,
  ) {
    const grant = (await this.inbox.listGrants()).find((entry) => entry.id === principal.id);
    if (!grant?.workspaceOverrides) return [];
    const workspaces = new Map(
      (await this.options.workspaceRegistry.listActive()).map((workspace) => [
        workspace.workspaceId,
        workspace,
      ]),
    );
    const targets: ConversationTarget[] = [];
    for (const agent of await this.options.agentStorage.listAll()) {
      if (!agent.workspaceId || agent.internal || agent.archivedAt) continue;
      const workspace = workspaces.get(agent.workspaceId);
      if (!workspace) continue;
      const target = { agentId: agent.id, workspaceId: workspace.workspaceId };
      if (await this.inbox.canDiscover(principal, { kind: "conversation", ...target })) {
        targets.push({
          ...target,
          workspaceName: workspace.title ?? workspace.displayName,
          title: agent.title ?? undefined,
        });
        if (targets.length >= 200) break;
      }
    }
    return targets;
  }

  private async tick() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const relayEnabled = this.options.relay().enabled;
      if (relayEnabled && (await this.inbox.listGrants()).length > 0) await this.getRelayOffer();
      this.relay?.setEnabled(relayEnabled);
      const requests = await this.inbox.list();
      for (const { state, sourceId, instruction } of requests) {
        if (state !== "queued" || instruction.target.kind !== "conversation") continue;
        const agentId = instruction.target.agentId;
        if (this.active.has(agentId)) continue;
        this.active.add(agentId);
        void this.dispatch(sourceId, instruction)
          .catch(() =>
            this.options.logger.warn(
              { requestId: instruction.id },
              "host_instruction_dispatch_failed",
            ),
          )
          .finally(() => this.active.delete(agentId));
      }
      await Promise.allSettled(
        this.outbox.pendingRegistrations().map((key) => this.outbox.flush(key)),
      );
    } finally {
      this.busy = false;
    }
  }

  private async resolveConversation(agentId: string) {
    const agent = await this.options.agentStorage.get(agentId);
    if (!agent?.workspaceId || agent.archivedAt || agent.internal) return null;
    const workspace = await this.options.workspaceRegistry.get(agent.workspaceId);
    if (!workspace || workspace.archivedAt) return null;
    return { kind: "conversation" as const, workspaceId: workspace.workspaceId, agentId };
  }

  private async dispatch(sourceId: string, instruction: z.infer<typeof HostInstructionSchema>) {
    const { target, id } = instruction;
    if (target.kind !== "conversation") return;
    const { agentStorage, agentManager, logger } = this.options;
    const live = agentManager.getAgent(target.agentId);
    if (live?.pendingPermissions.size || agentManager.hasInFlightRun(target.agentId)) return;
    const currentTarget = await this.resolveConversation(target.agentId);
    const claim = await this.inbox.claim(sourceId, id, currentTarget);
    if (claim?.state !== "dispatching") return;
    let admitted = false;
    try {
      const result = await sendPreparedPromptToAgent({
        agentManager,
        agentStorage,
        agentId: target.agentId,
        prompt: [
          {
            type: "text",
            text: `Host instruction from ${sourceId}. To send an explicit reply, use reply_host_instruction with sourceId "${sourceId}" and id "${id}".`,
          },
          { type: "text", text: instruction.prompt },
        ],
        runOptions: { clientMessageId: claim.messageId },
        idleOnly: true,
        unarchive: false,
        allowOutOfBand: false,
        admit: () => {
          admitted =
            !this.stopped &&
            this.inbox.canDispatch(sourceId, id) &&
            !agentManager.getAgent(target.agentId)?.pendingPermissions.size;
          return admitted;
        },
        logger,
      });
      if (result.disposition === "turn_started") {
        await waitForAgentRunStartWithTimeout(agentManager, target.agentId, result.started);
      }
      await this.inbox.markRunning(sourceId, id, target.agentId);
      while (!this.stopped && agentManager.hasInFlightRun(target.agentId)) await sleep(1000);
      const lifecycle = agentManager.getAgent(target.agentId)?.lifecycle;
      const outcome = lifecycle === "error" ? "failed" : "outcome_unknown";
      await this.inbox.finish(sourceId, id, lifecycle === "idle" ? "completed" : outcome);
      logger.info(
        { requestId: id, sourceId, agentId: target.agentId },
        "host_instruction_dispatched",
      );
    } catch (error) {
      if (
        error instanceof AgentTurnBusyError ||
        (!admitted && !this.inbox.canDispatch(sourceId, id))
      ) {
        await this.inbox.markBusy(sourceId, id);
      } else {
        await this.inbox.finish(sourceId, id, "outcome_unknown");
      }
    }
  }
}

async function exchange(
  registration: Registration | undefined,
  request: Exclude<Request, { action: "list" }>,
) {
  const id = request.action === "status" ? request.id : request.instruction.id;
  if (!registration) return { id, state: "revoked" as const };
  const result = await exchangeFrame(registration, request);
  if (!result) return null;
  return result.ok ? result.receipt : { id, state: result.state };
}

function exchangeFrame(registration: Registration, request: Request) {
  type Receipt = z.infer<typeof Reply> | null;
  let resolve!: (receipt: Receipt) => void;
  const promise = new Promise<Receipt>((complete) => {
    resolve = complete;
  });
  const transport = createHostTransportFactory(registration.offer)({
    url: "ws://instruction-relay",
  });
  let finished = false;
  const finish = (receipt: Receipt) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolve(receipt);
    transport.close();
  };
  const timer = setTimeout(() => finish(null), 8000);
  transport.onClose(() => finish(null));
  transport.onError(() => finish(null));
  transport.onOpen(async () => {
    try {
      await transport.send(JSON.stringify({ token: registration.token, request }));
    } catch {
      finish(null);
    }
  });
  transport.onMessage((value) => {
    try {
      if (typeof value !== "string" || value.length > 200_000) {
        finish(null);
        return;
      }
      const reply = Reply.parse(JSON.parse(value));
      finish(reply);
    } catch {
      finish(null);
    }
  });
  return promise;
}
