import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { createHostTransportFactory, parseHostTarget } from "@getpaseo/client/node";
import type {
  HostInstructionsCommand,
  HostInstructionsResponseSchema,
} from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentMessageDelivery } from "../agent/agent-messages/index.js";
import { AgentManagerShuttingDownError, type AgentManager } from "../agent/agent-manager.js";
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
import { HostInstructionInbox, HostInstructionSchema, type InboxRequest } from "./inbox.js";
import { HostInstructionOutbox, HostInstructionReceiptSchema } from "./outbox.js";
import {
  InstructionFileWriter,
  InstructionPersistenceError,
  readInstructionFile,
} from "./storage.js";

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

function instructionRelayIdentityFile(paseoHome: string): string {
  return path.join(paseoHome, "host-instructions", "relay-id.json");
}

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

interface ActiveInstruction {
  sourceId: string;
  id: string;
  admitted: boolean;
  claim?: Promise<InboxRequest | null>;
  releaseQueueOnShutdown?: () => void;
}

export class HostInstructionsRuntime {
  private relay: RelayRuntime | undefined;
  private relayOffer: Promise<string> | undefined;
  private credentialKey: Promise<string> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeStop: (() => void) | undefined;
  private unsubscribeTurns: (() => void) | undefined;
  private readonly active = new Map<string, ActiveInstruction>();
  private readonly discoveredTargets = new Map<string, ConversationTarget[]>();
  private busy = false;
  private stopped = false;
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly options: RuntimeOptions,
    private readonly inbox: HostInstructionInbox,
    private readonly registrations: Map<string, Registration>,
    private readonly registrationWriter: InstructionFileWriter,
    readonly outbox: HostInstructionOutbox,
    private relayId: string | null,
  ) {}

  start(agentMessages: Pick<AgentMessageDelivery, "sendDirect">): void {
    if (this.stopped || this.timer) return;
    const { agentManager } = this.options;
    this.unsubscribeStop = agentManager.onStop((agentId) => {
      const active = this.active.get(agentId);
      this.setStopHold(agentId, true, active?.admitted === false ? active : undefined);
    });
    this.unsubscribeTurns = agentManager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "turn_started") {
          this.setStopHold(event.agentId, false);
        }
      },
      { replayState: false },
    );
    this.timer = setInterval(() => {
      void this.tick(agentMessages).catch(() =>
        this.options.logger.warn("host_instruction_tick_failed"),
      );
    }, 3000);
    this.timer.unref();
  }

  private setStopHold(agentId: string, held: boolean, unadmitted?: ActiveInstruction): void {
    void this.inbox.setStopHold(agentId, held, unadmitted).catch(() => {
      this.options.logger.warn({ agentId, held }, "host_instruction_stop_hold_failed");
    });
  }

  static async open(options: RuntimeOptions) {
    const file = path.join(options.paseoHome, "host-instructions", "registrations.json");
    const saved = await readInstructionFile(file, z.array(Registration).parse, []);
    const registrations = new Map(saved.map((entry) => [registrationKey(entry), entry]));
    const inbox = await HostInstructionInbox.open(options.paseoHome);
    const writer = new InstructionFileWriter(file);
    const deliver = async (key: string, request: Exclude<Request, { action: "list" }>) => {
      const registration = await writer.readSettled(() => registrations.get(key));
      const receipt = await exchange(registration, request);
      if (receipt?.state === "revoked" && registration) {
        await retireRegistration(registrations, writer, registration);
      }
      return receipt;
    };
    const outbox = await HostInstructionOutbox.open(options.paseoHome, {
      submit: (key, instruction) => deliver(key, { action: "submit", instruction }),
      cancel: (key, instruction) => deliver(key, { action: "cancel", instruction }),
      status: (key, id, expiresAt) => deliver(key, { action: "status", id, expiresAt }),
    });
    const relayId = await readInstructionFile(
      instructionRelayIdentityFile(options.paseoHome),
      z.string().nullable().parse,
      null,
    );
    return new HostInstructionsRuntime(options, inbox, registrations, writer, outbox, relayId);
  }

  async manage(command: HostInstructionsCommand): Promise<ManagementResult> {
    if (this.stopped) throw new Error("Host instructions stopped");
    return this.dispatchManagement(command);
  }

  private async dispatchManagement(command: HostInstructionsCommand): Promise<ManagementResult> {
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
            const key = await this.getCredentialKey();
            return (id) => `${id}.${createHmac("sha256", key).update(id).digest("base64url")}`;
          },
          command.recoverRegistration,
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
      case "has_registration": {
        return this.registrationWriter.readSettled(() => {
          const registration = this.registrations.get(command.id);
          return {
            hasRegistration:
              registration?.destinationId === command.destinationId && !registration.agentId,
          };
        });
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
    const registrations = await this.registrationWriter.readSettled(() => [
      ...this.registrations.values(),
    ]);
    const hostTargets = await Promise.all(
      registrations
        .filter((entry) => !entry.agentId)
        .map(async (entry) =>
          (await this.discover(entry)).map((target) =>
            Object.assign({ destinationId: entry.destinationId }, target),
          ),
        ),
    );
    const hostPolicies = await this.registrationWriter.readSettled(
      () =>
        new Set(
          [...this.registrations.values()]
            .filter((entry) => !entry.agentId)
            .map((entry) => entry.destinationId),
        ),
    );
    const legacyTargets = registrations.flatMap(({ destinationId, agentId, workspaceId }) =>
      agentId && workspaceId && !hostPolicies.has(destinationId)
        ? [{ destinationId, agentId, workspaceId }]
        : [],
    );
    const unique = new Map(
      [...legacyTargets, ...hostTargets.flat()].map((entry) => [
        JSON.stringify([entry.destinationId, entry.agentId]),
        entry,
      ]),
    );
    return [...unique.values()];
  }

  private async discover(entry: Registration) {
    const key = registrationKey(entry);
    const result = await exchangeFrame(entry, { action: "list" });
    if (result && !result.ok && result.state === "revoked") {
      this.discoveredTargets.delete(key);
      await retireRegistration(this.registrations, this.registrationWriter, entry);
    } else if (result) {
      this.discoveredTargets.set(key, result.ok ? (result.targets ?? []) : []);
    }
    return this.discoveredTargets.get(key) ?? [];
  }

  async submit(destinationId: string, agentId: string, prompt: string, workspaceId?: string) {
    const entries = await this.registrationWriter.readSettled(() =>
      [...this.registrations.values()].filter(
        (registration) => registration.destinationId === destinationId,
      ),
    );
    const host = entries.findLast((registration) => !registration.agentId);
    const conversation = entries.findLast((registration) => registration.agentId === agentId);
    // Check for revocation before choosing when both credentials could route this instruction.
    // A missing response leaves the host credential eligible for offline queueing.
    const targets = host && (conversation || !workspaceId) ? await this.discover(host) : [];
    const entry = await this.registrationWriter.readSettled(() =>
      [host, conversation].find(
        (candidate) =>
          candidate && this.registrations.get(registrationKey(candidate)) === candidate,
      ),
    );
    if (!entry) throw new Error("This conversation has no instruction grant");
    const targetWorkspace =
      entry.workspaceId ??
      workspaceId ??
      targets.find((target) => target.agentId === agentId)?.workspaceId ??
      conversation?.workspaceId;
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

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribeStop?.();
    this.unsubscribeTurns?.();
    // Once admission is closed, these claims cannot run. Release them without
    // waiting for a provider to finish loading a session during shutdown.
    const unadmitted = [...this.active.values()].filter((dispatch) => !dispatch.admitted);
    for (const dispatch of unadmitted) dispatch.releaseQueueOnShutdown?.();
    this.closing = this.closeRelayAndRelease(unadmitted);
    return this.closing;
  }

  private async closeRelayAndRelease(unadmitted: ActiveInstruction[]) {
    const results = await Promise.allSettled([
      this.relay?.stop(),
      this.inbox.flush(),
      ...unadmitted.map(async ({ claim, sourceId, id }) => {
        if ((await claim)?.state === "dispatching") await this.inbox.markBusy(sourceId, id);
        return undefined;
      }),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private getCredentialKey(): Promise<string> {
    this.credentialKey ??= this.loadCredentialKey().catch((error: unknown) => {
      this.credentialKey = undefined;
      throw error;
    });
    return this.credentialKey;
  }

  private async loadCredentialKey() {
    const file = path.join(this.options.paseoHome, "host-instructions", "credential-key.json");
    const key = await readInstructionFile(file, z.string().min(43).nullable().parse, null);
    if (key) return key;
    const generated = randomBytes(32).toString("base64url");
    await new InstructionFileWriter(file).persist(generated);
    return generated;
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
    const routeId = this.relayId ?? `srv_${randomBytes(9).toString("base64url")}`;
    if (!this.relayId) {
      await new InstructionFileWriter(instructionRelayIdentityFile(this.options.paseoHome)).persist(
        routeId,
      );
      this.relayId = routeId;
    }
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
                  (error: unknown) =>
                    error instanceof InstructionPersistenceError
                      ? secured.close(1011, "Instruction storage unavailable")
                      : secured.close(1008, "Invalid instruction"),
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
          receipt: await this.inbox.cancelDelivery(principal, request.instruction, (claimed) => {
            const active = claimed.agentId ? this.active.get(claimed.agentId) : undefined;
            return (
              active?.sourceId === claimed.sourceId &&
              active.id === claimed.instruction.id &&
              !active.admitted
            );
          }),
        };
      }
      await this.inbox.submit(principal, request.instruction, async (target) => {
        if (target.kind !== "conversation") return false;
        // A sender may supply a workspace ID, but the receiver owns conversation placement.
        return (await this.resolveConversation(target.agentId))?.workspaceId === target.workspaceId;
      });
      return { ok: true, receipt: await this.inbox.status(principal, request.instruction.id) };
    } catch (error) {
      // The previous state can still be on disk. Close without issuing a terminal receipt.
      if (error instanceof InstructionPersistenceError) throw error;
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
      if (!agent.workspaceId || agent.internal || agent.archivedAt || agent.background) continue;
      const workspace = workspaces.get(agent.workspaceId);
      if (!workspace || workspace.background) continue;
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

  private async tick(agentMessages: Pick<AgentMessageDelivery, "sendDirect">) {
    if (this.stopped || this.busy) return;
    this.busy = true;
    void Promise.allSettled(
      this.outbox.pendingRegistrations().map((key) => this.outbox.flush(key, () => !this.stopped)),
    );
    try {
      const relayEnabled = this.options.relay().enabled;
      // Previously issued credentials must still receive a permanent rejection after revocation.
      if (relayEnabled && this.relayId) await this.getRelayOffer();
      if (this.stopped) return;
      this.relay?.setEnabled(relayEnabled);
      const requests = await this.inbox.list();
      if (this.stopped) return;
      for (const { state, sourceId, instruction, heldAfterStop } of requests) {
        if (state !== "queued" || heldAfterStop || instruction.target.kind !== "conversation")
          continue;
        const agentId = instruction.target.agentId;
        if (this.active.has(agentId)) continue;
        const dispatch = { sourceId, id: instruction.id, admitted: false };
        this.active.set(agentId, dispatch);
        void this.dispatch(dispatch, instruction, agentMessages)
          .catch(() =>
            this.options.logger.warn(
              { requestId: instruction.id },
              "host_instruction_dispatch_failed",
            ),
          )
          .finally(() => this.active.delete(agentId));
      }
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

  private async dispatch(
    active: ActiveInstruction,
    instruction: z.infer<typeof HostInstructionSchema>,
    agentMessages: Pick<AgentMessageDelivery, "sendDirect">,
  ) {
    const { sourceId } = active;
    const { target, id } = instruction;
    if (target.kind !== "conversation") return;
    const { agentStorage, agentManager, logger } = this.options;
    const live = agentManager.getAgent(target.agentId);
    if (live?.pendingPermissions.size || agentManager.hasInFlightRun(target.agentId)) return;
    const currentTarget = await this.resolveConversation(target.agentId);
    if (this.stopped) return;
    active.claim = this.inbox.claim(sourceId, id, currentTarget);
    const claim = await active.claim;
    if (this.stopped || claim?.state !== "dispatching") return;
    let blockedByPermission = false;
    try {
      const result = await agentMessages.sendDirect(
        {
          recipientId: target.agentId,
          prompt: `Host instruction from ${sourceId}. To send an explicit reply, use reply_host_instruction with sourceId "${sourceId}" and id "${id}".\n\n${instruction.prompt}`,
          source: { kind: "host-instruction", serverId: sourceId },
          messageId: claim.messageId,
          unarchive: false,
        },
        async (joined) => {
          if (this.stopped) throw new AgentManagerShuttingDownError();
          // Let the message queue reclaim its riders even if session loading is still blocked.
          const abandoned = new Promise<never>((_resolve, reject) => {
            active.releaseQueueOnShutdown = () => reject(new AgentManagerShuttingDownError());
          });
          return Promise.race([
            abandoned,
            sendPreparedPromptToAgent({
              agentManager,
              agentStorage,
              agentId: target.agentId,
              prompt: joined.prompt,
              sessionMode: joined.sessionMode,
              runOptions: { clientMessageId: claim.messageId },
              idleOnly: true,
              // A host instruction cannot reopen an archived conversation.
              unarchive: false,
              rejectArchived: true,
              allowOutOfBand: false,
              admit: () => {
                if (this.stopped || !this.inbox.canDispatch(sourceId, id)) return false;
                if (agentManager.getAgent(target.agentId)?.pendingPermissions.size) {
                  blockedByPermission = true;
                  return false;
                }
                active.admitted = true;
                return true;
              },
              logger,
            }).then(async (dispatch) => {
              if (dispatch.disposition !== "turn_started") {
                throw new Error("Expected an instruction turn");
              }
              await waitForAgentRunStartWithTimeout(agentManager, target.agentId, dispatch.started);
              return dispatch;
            }),
          ]);
        },
      );
      await this.inbox.markRunning(sourceId, id, target.agentId);
      await this.inbox.finish(sourceId, id, await result.finished);
      logger.info(
        { requestId: id, sourceId, agentId: target.agentId },
        "host_instruction_dispatched",
      );
    } catch (error) {
      // close() owns releasing claims that never passed admission.
      if (this.stopped && !active.admitted) return;
      active.claim = undefined;
      if (
        error instanceof AgentTurnBusyError ||
        (!active.admitted &&
          (blockedByPermission ||
            error instanceof AgentManagerShuttingDownError ||
            !this.inbox.canDispatch(sourceId, id)))
      ) {
        await this.inbox.markBusy(sourceId, id);
      } else {
        await this.inbox.finish(sourceId, id, "outcome_unknown");
      }
    }
  }
}

async function retireRegistration(
  registrations: Map<string, Registration>,
  writer: InstructionFileWriter,
  entry: Registration,
) {
  const key = registrationKey(entry);
  if (registrations.get(key) !== entry) return;
  registrations.delete(key);
  await writer.persist([...registrations.values()]);
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
