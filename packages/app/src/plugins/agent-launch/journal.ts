import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  PluginAgentLaunchEvent,
  PluginAgentLaunchOpenResult,
  PluginAgentLaunchRequest,
} from "@getpaseo/plugin/client";
import { z } from "zod";
import { useDraftStore, type AgentLaunchDraftMetadata } from "@/stores/draft-store";

const JOURNAL_PREFIX = "@paseo:plugin-agent-launch:v1:";
const JOURNAL_SCHEMA_VERSION = 1;
/**
 * Retention and entry caps are frozen from the Phase E capacity benchmark
 * (paseo-plugins/todolist/test/benchmark/capacity.ts). Terminal journals stay for 30 days so a
 * lost callback or RPC response cannot recreate a draft for a launch that already completed.
 */
export const AGENT_LAUNCH_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const AGENT_LAUNCH_JOURNAL_ENTRY_LIMIT = 128;

const MilestonesSchema = z.strictObject({
  preparedAt: z.number(),
  workspaceRequestStartedAt: z.number().optional(),
  workspaceKnownAt: z.number().optional(),
  workspaceOutcomeUnknownAt: z.number().optional(),
  agentRequestStartedAt: z.number().optional(),
  agentOutcomeUnknownAt: z.number().optional(),
  agentKnownAt: z.number().optional(),
  discardedAt: z.number().optional(),
});

const JournalSchema = z.strictObject({
  schemaVersion: z.literal(JOURNAL_SCHEMA_VERSION),
  journalKey: z.string(),
  serverId: z.string(),
  pluginId: z.string(),
  documentIncarnationId: z.string(),
  launchId: z.string(),
  requestFingerprint: z.string(),
  projectId: z.string(),
  draftId: z.string(),
  clientInstanceId: z.string(),
  clientMessageId: z.string(),
  labels: z.record(z.string(), z.string()),
  title: z.string().optional(),
  seedPrompt: z.string().optional(),
  phase: z.enum([
    "prepared",
    "workspace_request_started",
    "workspace_known",
    "workspace_outcome_unknown",
    "agent_request_started",
    "agent_outcome_unknown",
    "agent_known",
    "discarded",
  ]),
  submissionState: z.enum(["editable", "outcome_unknown_readonly"]),
  journalVersion: z.number().int().positive(),
  workspaceId: z.string().optional(),
  agentId: z.string().optional(),
  terminalOutcome: z.enum(["agent_known", "discarded"]).optional(),
  milestones: MilestonesSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type AgentLaunchJournal = z.infer<typeof JournalSchema>;
export type AgentLaunchJournalPhase = AgentLaunchJournal["phase"];

export type LaunchStorage = Pick<
  typeof AsyncStorage,
  "getItem" | "setItem" | "removeItem" | "getAllKeys" | "multiGet"
>;

type JournalReadResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "ready"; value: AgentLaunchJournal };

/**
 * Same-key serialization lives in this module's memory. It covers one JavaScript runtime only;
 * a second browser tab or Electron renderer sharing the same storage is not fenced (plan §6.2).
 */
const queues = new Map<string, Promise<unknown>>();
const callbacks = new Map<string, (event: PluginAgentLaunchEvent) => void>();
const draftStorage = new Map<string, LaunchStorage>();

export function buildAgentLaunchJournalKey(input: {
  serverId: string;
  pluginId: string;
  documentIncarnationId: string;
  launchId: string;
}): string {
  return `${JOURNAL_PREFIX}${[
    input.serverId,
    input.pluginId,
    input.documentIncarnationId,
    input.launchId,
  ]
    .map(encodeURIComponent)
    .join(":")}`;
}

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const pending = previous.then(work, work);
  const tail = pending.then(
    () => undefined,
    () => undefined,
  );
  const settled = tail.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
    return null;
  });
  queues.set(key, settled);
  return pending;
}

function hashKey(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function emit(key: string, event: PluginAgentLaunchEvent): void {
  try {
    callbacks.get(key)?.(event);
  } catch (error) {
    console.warn("[Plugins] Agent launch callback failed", {
      journalKeyHash: hashKey(key),
      eventType: event.type,
      error: error instanceof Error ? error.message : "callback failed",
    });
  }
}

async function readJournal(storage: LaunchStorage, key: string): Promise<JournalReadResult> {
  const raw = await storage.getItem(key);
  if (raw === null) return { status: "missing" };
  try {
    const parsed = JournalSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { status: "ready", value: parsed.data } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

async function persistJournal(storage: LaunchStorage, journal: AgentLaunchJournal): Promise<void> {
  await storage.setItem(journal.journalKey, JSON.stringify(journal));
}

function nextJournal(
  current: AgentLaunchJournal,
  patch: Partial<AgentLaunchJournal>,
): AgentLaunchJournal {
  return {
    ...current,
    ...patch,
    journalVersion: current.journalVersion + 1,
    updatedAt: Date.now(),
  };
}

function replay(journal: AgentLaunchJournal): void {
  const key = journal.journalKey;
  emit(key, {
    type: "journal_ready",
    clientInstanceId: journal.clientInstanceId,
    journalVersion: journal.journalVersion,
  });
  if (journal.milestones.workspaceRequestStartedAt) {
    emit(key, { type: "workspace_request_started", journalVersion: journal.journalVersion });
  }
  if (journal.workspaceId && journal.milestones.workspaceKnownAt) {
    emit(key, {
      type: "workspace_created",
      workspaceId: journal.workspaceId,
      journalVersion: journal.journalVersion,
    });
  }
  if (journal.workspaceId && journal.milestones.agentRequestStartedAt) {
    emit(key, {
      type: "agent_request_started",
      workspaceId: journal.workspaceId,
      journalVersion: journal.journalVersion,
    });
  }
  if (journal.milestones.workspaceOutcomeUnknownAt) {
    emit(key, {
      type: "failed",
      stage: "workspace_create",
      certainty: "outcome_unknown",
      message: "The workspace request outcome is unknown.",
      journalVersion: journal.journalVersion,
    });
  }
  if (journal.milestones.agentOutcomeUnknownAt) {
    emit(key, {
      type: "failed",
      stage: "agent_create",
      certainty: "outcome_unknown",
      message: "The agent request outcome is unknown.",
      ...(journal.workspaceId ? { workspaceId: journal.workspaceId } : {}),
      journalVersion: journal.journalVersion,
    });
  }
  if (journal.workspaceId && journal.agentId && journal.terminalOutcome === "agent_known") {
    emit(key, {
      type: "agent_created",
      workspaceId: journal.workspaceId,
      agentId: journal.agentId,
      journalVersion: journal.journalVersion,
    });
  } else if (journal.terminalOutcome === "discarded") {
    emit(key, {
      type: "discarded",
      certainty: "not_submitted",
      journalVersion: journal.journalVersion,
    });
  }
}

function metadataFromJournal(journal: AgentLaunchJournal): AgentLaunchDraftMetadata {
  return {
    draftId: journal.draftId,
    serverId: journal.serverId,
    pluginId: journal.pluginId,
    projectId: journal.projectId,
    launchId: journal.launchId,
    documentIncarnationId: journal.documentIncarnationId,
    journalKey: journal.journalKey,
    requestFingerprint: journal.requestFingerprint,
    labels: journal.labels,
    clientMessageId: journal.clientMessageId,
    submissionState: journal.submissionState,
  };
}

function rejected(
  code: Extract<PluginAgentLaunchOpenResult, { status: "rejected" }>["code"],
  message: string,
): { result: PluginAgentLaunchOpenResult; created: false } {
  return { result: { status: "rejected", code, message }, created: false };
}

export interface OpenAgentLaunchJournalInput {
  storage?: LaunchStorage;
  serverId: string;
  pluginId: string;
  clientInstanceId: string;
  request: PluginAgentLaunchRequest;
  initialWorkspaceId?: string;
  createDraftId: () => string;
  prepareDraft: (input: {
    draftId: string;
    metadata: AgentLaunchDraftMetadata;
    prompt: string;
    workspaceId?: string;
  }) => void;
}

export interface OpenAgentLaunchJournalOutput {
  result: PluginAgentLaunchOpenResult;
  journal?: AgentLaunchJournal;
  created: boolean;
}

export async function openAgentLaunchJournal(
  input: OpenAgentLaunchJournalInput,
): Promise<OpenAgentLaunchJournalOutput> {
  const storage = input.storage ?? AsyncStorage;
  const key = buildAgentLaunchJournalKey({
    serverId: input.serverId,
    pluginId: input.pluginId,
    documentIncarnationId: input.request.documentIncarnationId,
    launchId: input.request.launchId,
  });
  if (input.request.onEvent) callbacks.set(key, input.request.onEvent);
  if (
    input.request.expectedClientInstanceId &&
    input.request.expectedClientInstanceId !== input.clientInstanceId
  ) {
    return rejected("wrong_device", "This launch draft belongs to another Paseo app installation.");
  }

  return serialized(key, async () => {
    let stored: JournalReadResult;
    try {
      stored = await readJournal(storage, key);
    } catch {
      return rejected("journal_persist_failed", "Paseo could not read the local launch journal.");
    }
    if (stored.status === "invalid") {
      return rejected(
        "journal_invalid",
        "The local launch journal is invalid and must be cleared explicitly.",
      );
    }
    if (stored.status === "ready") {
      const journal = stored.value;
      if (journal.requestFingerprint !== input.request.requestFingerprint) {
        return rejected(
          "launch_key_conflict",
          "This launch identity was already used with different immutable inputs.",
        );
      }
      draftStorage.set(journal.draftId, storage);
      if (journal.terminalOutcome) {
        replay(journal);
        return {
          result: {
            status: "completed",
            clientInstanceId: journal.clientInstanceId,
            journalVersion: journal.journalVersion,
            terminalOutcome: journal.terminalOutcome,
            ...(journal.workspaceId ? { workspaceId: journal.workspaceId } : {}),
            ...(journal.agentId ? { agentId: journal.agentId } : {}),
          },
          journal,
          created: false,
        };
      }
      input.prepareDraft({
        draftId: journal.draftId,
        metadata: metadataFromJournal(journal),
        prompt: journal.seedPrompt ?? "",
        ...(journal.workspaceId ? { workspaceId: journal.workspaceId } : {}),
      });
      replay(journal);
      return {
        result: {
          status: "restored",
          clientInstanceId: journal.clientInstanceId,
          journalVersion: journal.journalVersion,
          submissionState: journal.submissionState,
        },
        journal,
        created: false,
      };
    }

    const now = Date.now();
    const draftId = input.createDraftId();
    const journal: AgentLaunchJournal = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      journalKey: key,
      serverId: input.serverId,
      pluginId: input.pluginId,
      documentIncarnationId: input.request.documentIncarnationId,
      launchId: input.request.launchId,
      requestFingerprint: input.request.requestFingerprint,
      projectId: input.request.projectId,
      draftId,
      clientInstanceId: input.clientInstanceId,
      clientMessageId: input.request.clientMessageId,
      labels: { ...input.request.labels },
      ...(input.request.title ? { title: input.request.title } : {}),
      seedPrompt: input.request.seedPrompt,
      phase: "prepared",
      submissionState: "editable",
      journalVersion: 1,
      ...(input.initialWorkspaceId ? { workspaceId: input.initialWorkspaceId } : {}),
      milestones: {
        preparedAt: now,
        ...(input.initialWorkspaceId ? { workspaceKnownAt: now } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };
    try {
      await persistJournal(storage, journal);
    } catch {
      emit(key, {
        type: "failed",
        stage: "journal",
        certainty: "not_submitted",
        message: "Paseo could not persist the local launch journal.",
      });
      return rejected(
        "journal_persist_failed",
        "Paseo could not persist the local launch journal.",
      );
    }
    draftStorage.set(draftId, storage);
    input.prepareDraft({
      draftId,
      metadata: metadataFromJournal(journal),
      prompt: input.request.seedPrompt,
      ...(input.initialWorkspaceId ? { workspaceId: input.initialWorkspaceId } : {}),
    });
    emit(key, {
      type: "journal_ready",
      clientInstanceId: input.clientInstanceId,
      journalVersion: 1,
    });
    if (input.initialWorkspaceId) {
      emit(key, {
        type: "workspace_created",
        workspaceId: input.initialWorkspaceId,
        journalVersion: 1,
      });
    }
    void garbageCollectAgentLaunchJournals(storage).catch(() => undefined);
    return {
      result: {
        status: "opened",
        clientInstanceId: input.clientInstanceId,
        journalVersion: 1,
        submissionState: "editable",
      },
      journal,
      created: true,
    };
  });
}

function storageForDraft(draftId: string): LaunchStorage {
  return draftStorage.get(draftId) ?? AsyncStorage;
}

async function updateForDraft(
  draftId: string,
  update: (journal: AgentLaunchJournal) => {
    next: AgentLaunchJournal;
    event?: PluginAgentLaunchEvent;
  },
): Promise<AgentLaunchJournal | null> {
  const metadata = useDraftStore.getState().getAgentLaunchMetadata(draftId);
  if (!metadata) return null;
  const storage = storageForDraft(draftId);
  return serialized(metadata.journalKey, async () => {
    const stored = await readJournal(storage, metadata.journalKey);
    if (stored.status !== "ready") throw new Error("Agent launch journal is unavailable");
    const result = update(stored.value);
    if (result.next !== stored.value) await persistJournal(storage, result.next);
    if (result.next.submissionState !== metadata.submissionState) {
      useDraftStore.getState().updateAgentLaunchSubmissionState({
        draftId,
        submissionState: result.next.submissionState,
      });
    }
    if (result.event) emit(metadata.journalKey, result.event);
    return result.next;
  });
}

/** Persists the workspace request-start milestone. Callers await this before `workspace.create`. */
export async function markWorkspaceRequestStarted(draftId: string): Promise<void> {
  await updateForDraft(draftId, (current) => {
    if (current.milestones.workspaceRequestStartedAt) return { next: current };
    const next = nextJournal(current, {
      phase: "workspace_request_started",
      milestones: { ...current.milestones, workspaceRequestStartedAt: Date.now() },
    });
    return {
      next,
      event: { type: "workspace_request_started", journalVersion: next.journalVersion },
    };
  });
}

export async function markWorkspaceCreated(draftId: string, workspaceId: string): Promise<void> {
  await updateForDraft(draftId, (current) => {
    const next = nextJournal(current, {
      phase: current.milestones.agentRequestStartedAt ? current.phase : "workspace_known",
      workspaceId: current.workspaceId ?? workspaceId,
      milestones: {
        ...current.milestones,
        workspaceKnownAt: current.milestones.workspaceKnownAt ?? Date.now(),
      },
    });
    return {
      next,
      event: {
        type: "workspace_created",
        workspaceId: next.workspaceId ?? workspaceId,
        journalVersion: next.journalVersion,
      },
    };
  });
}

/** Persists the agent request-start milestone. Callers await this before `create_agent_request`. */
export async function markAgentRequestStarted(draftId: string, workspaceId: string): Promise<void> {
  await updateForDraft(draftId, (current) => {
    if (current.milestones.agentRequestStartedAt) return { next: current };
    const next = nextJournal(current, {
      phase: "agent_request_started",
      workspaceId: current.workspaceId ?? workspaceId,
      milestones: {
        ...current.milestones,
        workspaceKnownAt: current.milestones.workspaceKnownAt ?? Date.now(),
        agentRequestStartedAt: Date.now(),
      },
    });
    return {
      next,
      event: {
        type: "agent_request_started",
        workspaceId: next.workspaceId ?? workspaceId,
        journalVersion: next.journalVersion,
      },
    };
  });
}

/**
 * Records a negative result for one stage. Certainty depends only on that stage's own
 * request-start milestone: before it, the stage is `not_submitted`; after it, the outcome is
 * unknown and the draft becomes read-only. When the journal itself cannot be read or written
 * after a request may have been sent, the draft is still locked read-only: an unreadable journal
 * cannot prove that nothing was submitted.
 */
export async function markLaunchOutcomeUnknown(input: {
  draftId: string;
  stage: "workspace_create" | "agent_create";
  message: string;
  workspaceId?: string;
}): Promise<void> {
  const workspaceStage = input.stage === "workspace_create";
  try {
    await updateForDraft(input.draftId, (current) => {
      const requestStarted = workspaceStage
        ? Boolean(current.milestones.workspaceRequestStartedAt)
        : Boolean(current.milestones.agentRequestStartedAt);
      const certainty = requestStarted ? "outcome_unknown" : "not_submitted";
      let phase = current.phase;
      if (requestStarted) {
        phase = workspaceStage ? "workspace_outcome_unknown" : "agent_outcome_unknown";
      }
      const next = nextJournal(current, {
        phase,
        submissionState: requestStarted ? "outcome_unknown_readonly" : current.submissionState,
        ...(input.workspaceId ? { workspaceId: current.workspaceId ?? input.workspaceId } : {}),
        milestones: {
          ...current.milestones,
          ...(requestStarted && workspaceStage
            ? {
                workspaceOutcomeUnknownAt:
                  current.milestones.workspaceOutcomeUnknownAt ?? Date.now(),
              }
            : {}),
          ...(requestStarted && !workspaceStage
            ? { agentOutcomeUnknownAt: current.milestones.agentOutcomeUnknownAt ?? Date.now() }
            : {}),
        },
      });
      return {
        next,
        event: {
          type: "failed",
          stage: input.stage,
          certainty,
          message: input.message,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          journalVersion: next.journalVersion,
        },
      };
    });
  } catch (error) {
    const metadata = useDraftStore.getState().getAgentLaunchMetadata(input.draftId);
    console.warn("[Plugins] Agent launch journal unavailable; locking draft as outcome unknown", {
      draftId: input.draftId,
      stage: input.stage,
      error: error instanceof Error ? error.message : "journal failed",
    });
    if (!metadata) return;
    useDraftStore.getState().updateAgentLaunchSubmissionState({
      draftId: input.draftId,
      submissionState: "outcome_unknown_readonly",
    });
    emit(metadata.journalKey, {
      type: "failed",
      stage: input.stage,
      certainty: "outcome_unknown",
      message: input.message,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    });
  }
}

/** Terminal: keeps the identity tombstone and clears only the sensitive seed content. */
export async function markAgentCreated(input: {
  draftId: string;
  workspaceId: string;
  agentId: string;
}): Promise<void> {
  await updateForDraft(input.draftId, (current) => {
    const next = nextJournal(current, {
      phase: "agent_known",
      workspaceId: current.workspaceId ?? input.workspaceId,
      agentId: current.agentId ?? input.agentId,
      terminalOutcome: "agent_known",
      milestones: {
        ...current.milestones,
        workspaceKnownAt: current.milestones.workspaceKnownAt ?? Date.now(),
        agentKnownAt: current.milestones.agentKnownAt ?? Date.now(),
      },
    });
    delete next.seedPrompt;
    delete next.title;
    return {
      next,
      event: {
        type: "agent_created",
        workspaceId: next.workspaceId ?? input.workspaceId,
        agentId: next.agentId ?? input.agentId,
        journalVersion: next.journalVersion,
      },
    };
  });
}

/**
 * Explicit discard. Allowed only while no request-start milestone exists; a started stage can
 * never be downgraded to `not_submitted`.
 */
export async function discardAgentLaunch(draftId: string): Promise<void> {
  await updateForDraft(draftId, (current) => {
    if (current.terminalOutcome === "discarded") return { next: current };
    if (current.milestones.workspaceRequestStartedAt || current.milestones.agentRequestStartedAt) {
      throw new Error("A submitted launch cannot be discarded as not submitted.");
    }
    const next = nextJournal(current, {
      phase: "discarded",
      terminalOutcome: "discarded",
      milestones: { ...current.milestones, discardedAt: Date.now() },
    });
    delete next.seedPrompt;
    delete next.title;
    return {
      next,
      event: { type: "discarded", certainty: "not_submitted", journalVersion: next.journalVersion },
    };
  });
}

export async function getAgentLaunchJournalForDraft(
  draftId: string,
): Promise<AgentLaunchJournal | null> {
  const metadata = useDraftStore.getState().getAgentLaunchMetadata(draftId);
  if (!metadata) return null;
  const stored = await readJournal(storageForDraft(draftId), metadata.journalKey);
  return stored.status === "ready" ? stored.value : null;
}

/**
 * Removing a plugin from the catalog clears this device's journals and their draft bindings for
 * that host/plugin. Offline devices clean up on their next reconnect or local GC; the daemon
 * cannot erase them immediately (plan §6.2).
 */
export async function removePluginAgentLaunchJournals(
  serverId: string,
  pluginId: string,
  storage: LaunchStorage = AsyncStorage,
): Promise<void> {
  const prefix = `${JOURNAL_PREFIX}${encodeURIComponent(serverId)}:${encodeURIComponent(pluginId)}:`;
  const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(prefix));
  await Promise.all(keys.map((key) => storage.removeItem(key)));
  const drafts = useDraftStore.getState().drafts;
  for (const [draftKey, record] of Object.entries(drafts)) {
    const launch = record.agentLaunch;
    if (!launch || launch.serverId !== serverId || launch.pluginId !== pluginId) continue;
    draftStorage.delete(launch.draftId);
    useDraftStore.getState().clearDraftInput({ draftKey, lifecycle: "abandoned" });
  }
}

export async function garbageCollectAgentLaunchJournals(
  storage: LaunchStorage = AsyncStorage,
  now: number = Date.now(),
): Promise<void> {
  const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(JOURNAL_PREFIX));
  if (keys.length === 0) return;
  const parsed = (await storage.multiGet(keys))
    .map(([key, raw]) => {
      if (!raw) return null;
      try {
        const result = JournalSchema.safeParse(JSON.parse(raw));
        return result.success ? { key, journal: result.data } : null;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { key: string; journal: AgentLaunchJournal } => entry !== null)
    .sort((left, right) => right.journal.updatedAt - left.journal.updatedAt);
  const expired = new Set(
    parsed
      .filter(
        ({ journal }) =>
          journal.terminalOutcome && now - journal.updatedAt > AGENT_LAUNCH_TERMINAL_RETENTION_MS,
      )
      .map(({ key }) => key),
  );
  // The entry cap evicts the oldest terminal journals first; an open launch keeps its recovery
  // promise even when the device holds more than the cap.
  const remaining = parsed.filter(({ key }) => !expired.has(key));
  let excess = remaining.length - AGENT_LAUNCH_JOURNAL_ENTRY_LIMIT;
  const evicted = new Set(expired);
  for (let index = remaining.length - 1; index >= 0 && excess > 0; index -= 1) {
    const entry = remaining[index]!;
    if (!entry.journal.terminalOutcome) continue;
    evicted.add(entry.key);
    excess -= 1;
  }
  await Promise.all([...evicted].map((key) => storage.removeItem(key)));
}

/**
 * Closing a launch's draft tab is the user's explicit discard. A draft marked abandoned is not:
 * the composer also abandons a draft whose content was emptied. A launch that already started a
 * request stage, or already ended, keeps its journal.
 */
export async function discardAgentLaunchForClosedDraft(draftId: string): Promise<void> {
  const journal = await getAgentLaunchJournalForDraft(draftId);
  if (!journal || journal.terminalOutcome) return;
  if (journal.milestones.workspaceRequestStartedAt || journal.milestones.agentRequestStartedAt) {
    return;
  }
  await discardAgentLaunch(draftId);
}
