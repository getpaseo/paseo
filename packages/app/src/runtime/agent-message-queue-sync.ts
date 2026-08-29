import {
  normalizeQueuedAgentMessageQueuePayload,
  type DaemonClient,
  type NormalizedQueuedAgentMessagePayload,
  type NormalizedQueuedAgentMessageQueuePayload,
} from "@getpaseo/client/internal/daemon-client";
import type {
  AgentAttachment,
  ForgeSearchItem,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { persistAttachmentFromDataUrl } from "@/attachments/service";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import type { QueuedComposerMessage } from "@/composer/actions";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import type { DirectoryConnection } from "@/runtime/directory-sync";
import type { DirectorySourceToken } from "@/runtime/directory-sync/transaction";
import { useSessionStore } from "@/stores/session-store";
import { encodeImages } from "@/utils/encode-images";
import { supportsAgentMessageQueue } from "@/utils/server-info-capabilities";

interface AgentQueueSyncState {
  revision: number | null;
  // COMPAT(localAgentQueueMigration): added in v0.6.2. Remove after 2027-02-26
  // once all supported clients have migrated their legacy local queue state.
  pendingMigration: QueuedComposerMessage[];
}

interface BuiltComposerAttachments {
  attachments: ComposerAttachment[];
  fullyEditable: boolean;
}

type AgentMessageQueueUpdatedEvent = Extract<
  SessionOutboundMessage,
  { type: "queue.agent_message.updated" }
>;

interface AgentMessageQueueClient {
  identity: object;
  getLastServerInfoMessage: DaemonClient["getLastServerInfoMessage"];
  listQueuedAgentMessages: DaemonClient["listQueuedAgentMessages"];
  queueAgentMessage: DaemonClient["queueAgentMessage"];
  subscribeQueueUpdates(
    listener: (message: AgentMessageQueueUpdatedEvent) => void | Promise<void>,
  ): () => void;
}

interface AgentMessageQueueConnection extends Omit<DirectoryConnection, "client"> {
  client: AgentMessageQueueClient | null;
}

export function toAgentMessageQueueConnection(
  connection: DirectoryConnection,
): AgentMessageQueueConnection {
  const client = connection.client;
  return {
    ...connection,
    client: client
      ? {
          identity: client,
          getLastServerInfoMessage: () => client.getLastServerInfoMessage(),
          listQueuedAgentMessages: (agentId) => client.listQueuedAgentMessages(agentId),
          queueAgentMessage: (agentId, text, options) =>
            client.queueAgentMessage(agentId, text, options),
          subscribeQueueUpdates: (listener) => client.on("queue.agent_message.updated", listener),
        }
      : null,
  };
}

function sourcesEqual(left: DirectorySourceToken, right: DirectorySourceToken): boolean {
  return (
    left.clientGeneration === right.clientGeneration &&
    left.connectionEpoch === right.connectionEpoch
  );
}

function forgeSearchItemFromAttachment(
  attachment: Extract<
    AgentAttachment,
    { type: "forge_issue" | "forge_change_request" | "github_issue" | "github_pr" }
  >,
): ForgeSearchItem {
  const isChangeRequest =
    attachment.type === "forge_change_request" || attachment.type === "github_pr";
  return {
    kind: isChangeRequest ? "change_request" : "issue",
    forge: "forge" in attachment ? (attachment.forge ?? "github") : "github",
    number: attachment.number,
    title: attachment.title,
    url: attachment.url,
    state: "unknown",
    body: attachment.body ?? null,
    labels: [],
    ...(isChangeRequest && attachment.baseRefName ? { baseRefName: attachment.baseRefName } : {}),
    ...(isChangeRequest && attachment.headRefName ? { headRefName: attachment.headRefName } : {}),
    ...("projectPath" in attachment && attachment.projectPath
      ? { projectPath: attachment.projectPath }
      : {}),
  };
}

function composerAttachmentFromAgentAttachment(
  attachment: AgentAttachment,
): UserComposerAttachment | null {
  switch (attachment.type) {
    case "uploaded_file":
      return { kind: "file", attachment };
    case "forge_issue":
      return { kind: "forge_issue", item: forgeSearchItemFromAttachment(attachment) };
    case "forge_change_request":
      return { kind: "forge_change_request", item: forgeSearchItemFromAttachment(attachment) };
    case "github_issue":
      return { kind: "github_issue", item: forgeSearchItemFromAttachment(attachment) };
    case "github_pr":
      return { kind: "github_pr", item: forgeSearchItemFromAttachment(attachment) };
    case "review":
    case "text":
      // These wire shapes do not retain enough current-main composer ownership
      // to reconstruct a safe editable attachment. The queued turn still keeps
      // the original wire payload on the daemon and can always be dispatched.
      return null;
  }
}

async function buildComposerAttachments(input: {
  serverId: string;
  message: NormalizedQueuedAgentMessagePayload;
}): Promise<BuiltComposerAttachments> {
  let fullyEditable = true;
  const images = await Promise.all(
    input.message.images.map(async (image, index) => {
      try {
        return {
          kind: "image" as const,
          metadata: await persistAttachmentFromDataUrl({
            id: `queued:${input.serverId}:${input.message.agentId}:${input.message.id}:image:${index}`,
            dataUrl: `data:${image.mimeType};base64,${image.data}`,
            mimeType: image.mimeType,
          }),
        };
      } catch (error) {
        fullyEditable = false;
        console.error("[AgentMessageQueue] Failed to persist queued image:", error);
        return null;
      }
    }),
  );
  const attachments: ComposerAttachment[] = images.filter(
    (image): image is NonNullable<typeof image> => image !== null,
  );
  for (const attachment of input.message.attachments) {
    const composerAttachment = composerAttachmentFromAgentAttachment(attachment);
    if (composerAttachment) {
      attachments.push(composerAttachment);
    } else {
      fullyEditable = false;
    }
  }
  fullyEditable &&=
    input.message.imageCount === input.message.images.length &&
    input.message.attachmentCount === input.message.attachments.length;
  return { attachments, fullyEditable };
}

function needsPayloadHydration(
  queue: NormalizedQueuedAgentMessageQueuePayload,
  mirrored: readonly QueuedComposerMessage[] | undefined,
): boolean {
  const mirroredIds = new Set((mirrored ?? []).map((message) => message.id));
  return queue.messages.some(
    (message) =>
      !mirroredIds.has(message.id) &&
      (message.imageCount > message.images.length ||
        message.attachmentCount > message.attachments.length),
  );
}

async function mergeQueuedMessages(input: {
  serverId: string;
  previous: readonly QueuedComposerMessage[] | undefined;
  incoming: NormalizedQueuedAgentMessagePayload[];
}): Promise<QueuedComposerMessage[]> {
  const previousById = new Map((input.previous ?? []).map((message) => [message.id, message]));
  return await Promise.all(
    input.incoming.map(async (message) => {
      const previous = previousById.get(message.id);
      if (previous) {
        return previous;
      }
      const built = await buildComposerAttachments({ serverId: input.serverId, message });
      return {
        id: message.id,
        text: message.text,
        attachments: built.attachments,
        canEdit: built.fullyEditable,
      };
    }),
  );
}

/**
 * Per-host owner for daemon queue mirroring and one-time migration of the
 * legacy local queue. Its source token and active-agent set come from the same
 * HostRuntime/DirectorySync lifecycle that owns every other directory replica.
 */
export class AgentMessageQueueSync {
  private readonly stateByAgent = new Map<string, AgentQueueSyncState>();
  private connection: AgentMessageQueueConnection = {
    client: null,
    status: "offline",
    source: { clientGeneration: 0, connectionEpoch: 0 },
  };
  private activeAgentIds: Set<string> | null = null;
  private unsubscribeQueueUpdates: (() => void) | null = null;
  private hasStartedInitialSync = false;
  private ownsDaemonQueueMirror = false;

  constructor(private serverId: string) {}

  adoptServerId(serverId: string): void {
    this.serverId = serverId;
  }

  connectionChanged(connection: AgentMessageQueueConnection): boolean {
    const changed =
      this.connection.client?.identity !== connection.client?.identity ||
      this.connection.status !== connection.status ||
      !sourcesEqual(this.connection.source, connection.source);
    if (!changed) {
      this.startInitialSyncIfReady();
      return false;
    }

    this.unsubscribeQueueUpdates?.();
    this.unsubscribeQueueUpdates = null;
    this.connection = connection;
    this.activeAgentIds = null;
    this.hasStartedInitialSync = false;
    for (const state of this.stateByAgent.values()) state.revision = null;

    const serverInfo = connection.client?.getLastServerInfoMessage();
    if (
      connection.status === "online" &&
      connection.client &&
      !supportsAgentMessageQueue(serverInfo) &&
      this.ownsDaemonQueueMirror
    ) {
      this.restorePendingMigrationQueues();
      this.ownsDaemonQueueMirror = false;
    }
    if (
      connection.status !== "online" ||
      !connection.client ||
      !supportsAgentMessageQueue(serverInfo)
    ) {
      return true;
    }
    const client = connection.client;
    const source = connection.source;
    this.unsubscribeQueueUpdates = client.subscribeQueueUpdates((message) => {
      if (message.type !== "queue.agent_message.updated" || !this.isCurrent(client, source)) return;
      return this.applyEventQueue(
        client,
        source,
        normalizeQueuedAgentMessageQueuePayload(message.payload),
      ).catch((error) => {
        if (this.isCurrent(client, source)) {
          console.error("[AgentMessageQueue] Failed to apply queue update:", error);
        }
      });
    });
    return true;
  }

  directoryCommitted(agentIds: Iterable<string>, source: DirectorySourceToken): void {
    if (!sourcesEqual(this.connection.source, source)) return;
    const nextAgentIds = new Set(agentIds);
    this.activeAgentIds = nextAgentIds;
    for (const agentId of this.stateAndMirrorAgentIds()) {
      if (!nextAgentIds.has(agentId)) this.removeAgent(agentId, source);
    }
    this.startInitialSyncIfReady();
  }

  removeAgent(agentId: string, source: DirectorySourceToken): void {
    if (!sourcesEqual(this.connection.source, source)) return;
    this.stateByAgent.delete(agentId);
    this.activeAgentIds?.delete(agentId);
    useSessionStore.getState().setQueuedMessages(this.serverId, (previous) => {
      if (!previous.has(agentId)) return previous;
      const next = new Map(previous);
      next.delete(agentId);
      return next;
    });
  }

  isDaemonQueueEnabled(): boolean {
    return supportsAgentMessageQueue(this.connection.client?.getLastServerInfoMessage());
  }

  dispose(): void {
    this.unsubscribeQueueUpdates?.();
    this.unsubscribeQueueUpdates = null;
    this.connection = {
      client: null,
      status: "offline",
      source: this.connection.source,
    };
    this.activeAgentIds = null;
    this.hasStartedInitialSync = false;
    this.ownsDaemonQueueMirror = false;
    this.stateByAgent.clear();
  }

  private restorePendingMigrationQueues(): void {
    const pendingByAgent = new Map<string, QueuedComposerMessage[]>();
    for (const [agentId, state] of this.stateByAgent) {
      if (state.pendingMigration.length > 0) {
        pendingByAgent.set(agentId, [...state.pendingMigration]);
      }
    }
    this.stateByAgent.clear();
    useSessionStore.getState().setQueuedMessages(this.serverId, pendingByAgent);
  }

  private stateAndMirrorAgentIds(): Set<string> {
    return new Set([
      ...this.stateByAgent.keys(),
      ...(useSessionStore.getState().sessions[this.serverId]?.queuedMessages.keys() ?? []),
    ]);
  }

  private startInitialSyncIfReady(): void {
    const { client, status, source } = this.connection;
    if (
      this.hasStartedInitialSync ||
      status !== "online" ||
      !client ||
      !this.activeAgentIds ||
      !this.isDaemonQueueEnabled()
    ) {
      return;
    }
    this.hasStartedInitialSync = true;
    void this.runInitialSync(client, source).catch((error) => {
      if (this.isCurrent(client, source)) {
        console.error("[AgentMessageQueue] Failed to sync queued messages:", error);
        this.hasStartedInitialSync = false;
      }
    });
  }

  private async runInitialSync(
    client: AgentMessageQueueClient,
    source: DirectorySourceToken,
  ): Promise<void> {
    const localQueues =
      useSessionStore.getState().sessions[this.serverId]?.queuedMessages ?? new Map();
    for (const [agentId, messages] of localQueues) {
      if (!this.isActiveAgent(agentId) || this.stateByAgent.has(agentId)) continue;
      this.stateByAgent.set(agentId, {
        revision: null,
        pendingMigration: [...messages],
      });
    }
    this.ownsDaemonQueueMirror = true;

    for (const [agentId, state] of this.stateByAgent) {
      if (!this.isCurrent(client, source)) return;
      if (!this.isActiveAgent(agentId)) continue;
      await this.migrateAgentQueue(client, source, agentId, state);
    }

    const queues = await client.listQueuedAgentMessages();
    if (!this.isCurrent(client, source)) return;
    const seenAgentIds = new Set(queues.map((queue) => queue.agentId));
    for (const queue of queues) {
      await this.applyQueue(client, source, queue);
    }
    for (const agentId of this.stateAndMirrorAgentIds()) {
      if (!this.isCurrent(client, source)) return;
      if (this.isActiveAgent(agentId) && !seenAgentIds.has(agentId)) {
        await this.applyQueue(client, source, { agentId, revision: 0, messages: [] });
      }
    }
  }

  private async migrateAgentQueue(
    client: AgentMessageQueueClient,
    source: DirectorySourceToken,
    agentId: string,
    initialState: AgentQueueSyncState,
  ): Promise<void> {
    for (const message of initialState.pendingMigration) {
      if (!this.isCurrent(client, source) || !this.isActiveAgent(agentId)) return;
      try {
        const session = useSessionStore.getState().sessions[this.serverId];
        const payload = splitComposerAttachmentsForSubmit(message.attachments, {
          format: resolveComposerAttachmentSubmitFormat({
            supportsForgeAttachments: session?.serverInfo?.features?.forgeSearch === true,
          }),
        });
        const images = await encodeImages(payload.images);
        await client.queueAgentMessage(agentId, message.text, {
          messageId: message.id,
          ...(images && images.length > 0 ? { images } : {}),
          ...(payload.attachments.length > 0 ? { attachments: payload.attachments } : {}),
        });
      } catch (error) {
        console.error("[AgentMessageQueue] Failed to migrate locally queued message:", error);
        // Preserve FIFO: once one item fails, its entire suffix remains local
        // and is retried in order on the next connection.
        return;
      }
      if (!this.isCurrent(client, source)) return;
      const current = this.stateByAgent.get(agentId);
      if (!current) return;
      current.pendingMigration = current.pendingMigration.filter(
        (candidate) => candidate.id !== message.id,
      );
    }
  }

  private async applyEventQueue(
    client: AgentMessageQueueClient,
    source: DirectorySourceToken,
    queue: NormalizedQueuedAgentMessageQueuePayload,
  ): Promise<void> {
    if (!this.isActiveAgent(queue.agentId)) return;
    const mirrored = useSessionStore
      .getState()
      .sessions[this.serverId]?.queuedMessages.get(queue.agentId);
    const hydrated = needsPayloadHydration(queue, mirrored)
      ? (await client.listQueuedAgentMessages(queue.agentId))[0]
      : queue;
    if (hydrated) await this.applyQueue(client, source, hydrated);
  }

  private async applyQueue(
    client: AgentMessageQueueClient,
    source: DirectorySourceToken,
    queue: NormalizedQueuedAgentMessageQueuePayload,
  ): Promise<void> {
    if (!this.isCurrent(client, source) || !this.isActiveAgent(queue.agentId)) return;
    const state = this.stateByAgent.get(queue.agentId) ?? {
      revision: null,
      pendingMigration: [],
    };
    if (state.revision !== null && queue.revision < state.revision) return;

    const previous = useSessionStore
      .getState()
      .sessions[this.serverId]?.queuedMessages.get(queue.agentId);
    const serverMessages = await mergeQueuedMessages({
      serverId: this.serverId,
      previous,
      incoming: queue.messages,
    });
    if (!this.isCurrent(client, source) || !this.isActiveAgent(queue.agentId)) return;
    const latest = this.stateByAgent.get(queue.agentId) ?? state;
    if (latest.revision !== null && queue.revision < latest.revision) return;

    latest.revision = queue.revision;
    this.stateByAgent.set(queue.agentId, latest);
    const serverIds = new Set(serverMessages.map((message) => message.id));
    const pending = latest.pendingMigration.filter((message) => !serverIds.has(message.id));
    const messages = [...serverMessages, ...pending];
    useSessionStore.getState().setQueuedMessages(this.serverId, (current) => {
      const existing = current.get(queue.agentId);
      if (messages.length === 0) {
        if (!existing) return current;
        const next = new Map(current);
        next.delete(queue.agentId);
        return next;
      }
      const next = new Map(current);
      next.set(queue.agentId, messages);
      return next;
    });
  }

  private isCurrent(client: AgentMessageQueueClient, source: DirectorySourceToken): boolean {
    return (
      this.connection.client === client &&
      this.connection.status === "online" &&
      sourcesEqual(this.connection.source, source)
    );
  }

  private isActiveAgent(agentId: string): boolean {
    return this.activeAgentIds?.has(agentId) === true;
  }
}
