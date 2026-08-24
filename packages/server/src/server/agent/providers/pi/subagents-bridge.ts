import { z } from "zod";

import type { AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";
import type { PiRuntimeEvent } from "./rpc-types.js";

const ASYNC_WIDGET_KEY = "subagent-async";
const ASYNC_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const ASYNC_SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
const ASYNC_SNAPSHOT_VERSION = 1;
const INSPECT_WIDGET_KEY = "subagent-inspect";
const INSPECT_WIDGET_PREFIX = "PI_SUBAGENT_INSPECT_JSON:";
const INSPECT_REPLY_KIND = "pi-subagents.inspect-reply";
const INSPECT_REPLY_VERSION = 1;
const MAX_WIDGET_BYTES = 64 * 1024;

const SnapshotStateSchema = z.enum([
  "queued",
  "running",
  "complete",
  "failed",
  "paused",
  "stopped",
  "rejected",
]);

const SnapshotActivitySchema = z
  .object({
    state: z.string().optional(),
    currentTool: z.string().optional(),
    lastActivityAt: z.number().int().nonnegative().optional(),
    currentToolStartedAt: z.number().int().nonnegative().optional(),
    turnCount: z.number().int().nonnegative().optional(),
    toolCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

interface SnapshotNode {
  id: string;
  kind: "subagent" | "workflow" | "step";
  label: string;
  state: z.infer<typeof SnapshotStateSchema>;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  activity?: z.infer<typeof SnapshotActivitySchema>;
  children?: SnapshotNode[];
}

const SnapshotNodeSchema: z.ZodType<SnapshotNode> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1).max(256),
      kind: z.enum(["subagent", "workflow", "step"]),
      label: z.string().min(1).max(256),
      state: SnapshotStateSchema,
      startedAt: z.number().int().nonnegative().optional(),
      updatedAt: z.number().int().nonnegative().optional(),
      endedAt: z.number().int().nonnegative().optional(),
      activity: SnapshotActivitySchema.optional(),
      children: z.array(SnapshotNodeSchema).max(64).optional(),
    })
    .passthrough(),
);

const AsyncSnapshotSchema = z
  .object({
    kind: z.literal(ASYNC_SNAPSHOT_KIND),
    version: z.literal(ASYNC_SNAPSHOT_VERSION),
    generatedAt: z.number().int().nonnegative(),
    omitted: z
      .object({
        runs: z.number().int().nonnegative(),
        children: z.number().int().nonnegative(),
        byteLimitExceeded: z.boolean(),
      })
      .passthrough()
      .optional(),
    runs: z.array(SnapshotNodeSchema).max(64),
  })
  .passthrough();

const InspectMessageSchema = z
  .object({
    role: z.string().max(32),
    kind: z.enum(["text", "toolCall", "toolResult"]),
    text: z.string().max(4_096),
    name: z.string().max(128).optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

const InspectReplySchema = z
  .object({
    kind: z.literal(INSPECT_REPLY_KIND),
    version: z.literal(INSPECT_REPLY_VERSION),
    requestId: z.string().min(1).max(64),
    asyncId: z.string().max(256).optional(),
    childId: z.string().max(256).optional(),
    status: z.string().max(32).optional(),
    label: z.string().max(256).optional(),
    task: z.string().max(4_096).optional(),
    messages: z.array(InspectMessageSchema).max(200).optional(),
    finalOutput: z.string().max(16_384).optional(),
    truncated: z
      .object({
        task: z.boolean(),
        messages: z.number().int().nonnegative(),
        finalOutput: z.boolean(),
      })
      .passthrough()
      .optional(),
    error: z
      .object({
        code: z.string().max(64),
        message: z.string().max(1_024),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type AsyncSnapshot = z.infer<typeof AsyncSnapshotSchema>;
type InspectReply = z.infer<typeof InspectReplySchema>;

export interface PiSubagentTarget {
  asyncId: string;
  childId?: string;
}

export interface PiSubagentInspectionTarget {
  descriptorId: string;
  target: PiSubagentTarget;
  terminal: boolean;
}

export interface PiSubagentsBridgeResult {
  handled: boolean;
  events: AgentStreamEvent[];
  inspectionTargets: PiSubagentInspectionTarget[];
}

interface FlattenedNode {
  node: SnapshotNode;
  target: PiSubagentTarget;
  descriptorId: string;
  parentLabel?: string;
}

interface PendingInspection {
  descriptorId: string;
  target: PiSubagentTarget;
}

export class PiSubagentsBridge {
  private readonly targets = new Map<string, PiSubagentTarget>();
  private readonly pendingInspections = new Map<string, PendingInspection>();
  private readonly projectedDescriptorIds = new Set<string>();
  private lastCompatibilityError: string | null = null;

  handleExtensionUiRequest(
    event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  ): PiSubagentsBridgeResult {
    if (event.method !== "setWidget") {
      return emptyResult(false);
    }
    if (event.widgetKey === INSPECT_WIDGET_KEY) {
      return this.handleInspectWidget(event.widgetLines);
    }
    if (event.widgetKey !== ASYNC_WIDGET_KEY) {
      return emptyResult(false);
    }

    const line = firstWidgetLine(event.widgetLines);
    if (!line?.startsWith(ASYNC_WIDGET_PREFIX)) {
      return emptyResult(true);
    }
    if (Buffer.byteLength(line, "utf8") > MAX_WIDGET_BYTES) {
      return this.compatibilityFailure(
        "Pi Subagents status exceeded the supported host payload size.",
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(ASYNC_WIDGET_PREFIX.length)) as unknown;
    } catch {
      return this.compatibilityFailure("Pi Subagents returned an invalid status payload.");
    }
    const parsed = AsyncSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
      const version = record && "version" in record ? String(record.version) : "unknown";
      return this.compatibilityFailure(
        `Pi Subagents status protocol version ${version} is not supported by this Paseo build.`,
      );
    }

    this.lastCompatibilityError = null;
    const flattened = flattenSnapshot(parsed.data);
    const currentIds = new Set(flattened.map((entry) => entry.descriptorId));
    const events = flattened.map((entry) => {
      this.targets.set(entry.descriptorId, entry.target);
      this.projectedDescriptorIds.add(entry.descriptorId);
      return toProviderSubagentEvent(entry, parsed.data);
    });
    if (canReconcileAbsence(parsed.data)) {
      for (const descriptorId of this.projectedDescriptorIds) {
        if (currentIds.has(descriptorId)) continue;
        events.push({
          type: "provider_subagent",
          provider: "pi",
          event: { type: "remove", id: descriptorId },
        });
        this.projectedDescriptorIds.delete(descriptorId);
        this.targets.delete(descriptorId);
      }
    }
    return {
      handled: true,
      events,
      inspectionTargets: flattened.map((entry) => ({
        descriptorId: entry.descriptorId,
        target: entry.target,
        terminal: isTerminal(entry.node.state),
      })),
    };
  }

  beginInspection(requestId: string, descriptorId: string): PiSubagentTarget | null {
    const target = this.targets.get(descriptorId);
    if (!target) return null;
    this.pendingInspections.set(requestId, { descriptorId, target });
    return { ...target };
  }

  failInspection(requestId: string): void {
    this.pendingInspections.delete(requestId);
  }

  resolveTarget(descriptorId: string): PiSubagentTarget | null {
    const target = this.targets.get(descriptorId);
    return target ? { ...target } : null;
  }

  private handleInspectWidget(widgetLines: unknown): PiSubagentsBridgeResult {
    const line = firstWidgetLine(widgetLines);
    if (!line?.startsWith(INSPECT_WIDGET_PREFIX)) {
      return emptyResult(true);
    }
    if (Buffer.byteLength(line, "utf8") > MAX_WIDGET_BYTES) {
      return this.compatibilityFailure(
        "Pi Subagents inspection exceeded the supported host payload size.",
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(INSPECT_WIDGET_PREFIX.length)) as unknown;
    } catch {
      return emptyResult(true);
    }
    const parsed = InspectReplySchema.safeParse(raw);
    if (!parsed.success) {
      return emptyResult(true);
    }
    const pending = this.pendingInspections.get(parsed.data.requestId);
    if (!pending) {
      return emptyResult(true);
    }
    this.pendingInspections.delete(parsed.data.requestId);
    return {
      handled: true,
      events: inspectionEvents(pending.descriptorId, parsed.data),
      inspectionTargets: [],
    };
  }

  private compatibilityFailure(message: string): PiSubagentsBridgeResult {
    if (this.lastCompatibilityError === message) {
      return emptyResult(true);
    }
    this.lastCompatibilityError = message;
    return {
      handled: true,
      events: [
        {
          type: "timeline",
          provider: "pi",
          item: { type: "error", message },
        },
      ],
      inspectionTargets: [],
    };
  }
}

function emptyResult(handled: boolean): PiSubagentsBridgeResult {
  return { handled, events: [], inspectionTargets: [] };
}

function firstWidgetLine(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first = value[0];
  return typeof first === "string" ? first : null;
}

function flattenSnapshot(snapshot: AsyncSnapshot): FlattenedNode[] {
  const entries: FlattenedNode[] = [];
  for (const run of snapshot.runs) {
    if (run.kind === "subagent" && run.children?.length === 1) {
      const child = run.children[0];
      flattenNode(entries, child, { asyncId: run.id, childId: child.id }, [run.id], undefined);
      continue;
    }
    flattenNode(entries, run, { asyncId: run.id }, [], undefined);
  }
  return entries;
}

function flattenNode(
  entries: FlattenedNode[],
  node: SnapshotNode,
  target: PiSubagentTarget,
  path: string[],
  parentLabel: string | undefined,
): void {
  const currentPath = [...path, node.id];
  const descriptorId = encodeDescriptorId(target.asyncId, currentPath);
  entries.push({ node, target, descriptorId, parentLabel });
  for (const child of node.children ?? []) {
    flattenNode(
      entries,
      child,
      { asyncId: target.asyncId, childId: child.id },
      currentPath,
      node.label,
    );
  }
}

function encodeDescriptorId(asyncId: string, path: string[]): string {
  return `pi-subagents:${Buffer.from(JSON.stringify({ asyncId, path }), "utf8").toString("base64url")}`;
}

function toProviderSubagentEvent(entry: FlattenedNode, snapshot: AsyncSnapshot): AgentStreamEvent {
  return {
    type: "provider_subagent",
    provider: "pi",
    event: {
      type: "upsert",
      id: entry.descriptorId,
      title: entry.node.label,
      description: entry.parentLabel
        ? `${entry.parentLabel} / ${entry.node.label}`
        : entry.node.label,
      status: mapStatus(entry.node.state),
      subtitle: formatSubtitle(entry.node, snapshot.generatedAt),
      ...(entry.node.startedAt !== undefined
        ? { timestamp: new Date(entry.node.startedAt).toISOString() }
        : {}),
    },
  };
}

function inspectionEvents(descriptorId: string, reply: InspectReply): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  if (reply.task || reply.label || reply.status) {
    events.push({
      type: "provider_subagent",
      provider: "pi",
      event: {
        type: "upsert",
        id: descriptorId,
        ...(reply.label ? { title: reply.label } : {}),
        ...(reply.task ? { description: reply.task } : {}),
        ...(reply.status ? { status: mapInspectStatus(reply.status) } : {}),
      },
    });
  }
  if (reply.error) {
    events.push(
      toSubagentTimeline(descriptorId, {
        type: "error",
        message: `${reply.error.code}: ${reply.error.message}`,
      }),
    );
    return events;
  }
  for (const [index, message] of (reply.messages ?? []).entries()) {
    events.push(toSubagentTimeline(descriptorId, inspectMessageToTimeline(message, index)));
  }
  if (reply.finalOutput) {
    events.push(
      toSubagentTimeline(descriptorId, {
        type: "assistant_message",
        text: reply.finalOutput,
      }),
    );
  }
  if (
    reply.truncated &&
    (reply.truncated.task || reply.truncated.messages > 0 || reply.truncated.finalOutput)
  ) {
    events.push(
      toSubagentTimeline(descriptorId, {
        type: "assistant_message",
        text: `[Inspection truncated: ${reply.truncated.messages} messages omitted]`,
      }),
    );
  }
  return events;
}

function inspectMessageToTimeline(
  message: z.infer<typeof InspectMessageSchema>,
  index: number,
): AgentTimelineItem {
  if (message.kind === "toolCall") {
    const item = {
      type: "tool_call" as const,
      callId: `pi-subagents-inspect-${index}`,
      name: message.name ?? "tool",
      detail: { type: "plain_text" as const, text: message.text },
    };
    return message.isError
      ? { ...item, status: "failed", error: message.text }
      : { ...item, status: "completed", error: null };
  }
  if (message.kind === "toolResult" && message.isError) {
    return { type: "error", message: message.text };
  }
  if (message.role === "user") {
    return { type: "user_message", text: message.text };
  }
  return { type: "assistant_message", text: message.text };
}

function toSubagentTimeline(descriptorId: string, item: AgentTimelineItem): AgentStreamEvent {
  return {
    type: "provider_subagent",
    provider: "pi",
    event: { type: "timeline", id: descriptorId, item },
  };
}

function mapStatus(state: SnapshotNode["state"]): "running" | "completed" | "failed" | "canceled" {
  if (state === "complete") return "completed";
  if (state === "stopped") return "canceled";
  if (state === "failed" || state === "paused" || state === "rejected") return "failed";
  return "running";
}

function mapInspectStatus(status: string): "running" | "completed" | "failed" | "canceled" {
  if (status === "complete" || status === "completed") return "completed";
  if (status === "stopped" || status === "canceled" || status === "cancelled") return "canceled";
  if (status === "failed" || status === "paused" || status === "rejected") return "failed";
  return "running";
}

function isTerminal(state: SnapshotNode["state"]): boolean {
  return (
    state === "complete" ||
    state === "failed" ||
    state === "paused" ||
    state === "stopped" ||
    state === "rejected"
  );
}

function canReconcileAbsence(snapshot: AsyncSnapshot): boolean {
  return (
    snapshot.omitted?.runs === 0 &&
    snapshot.omitted.children === 0 &&
    snapshot.omitted.byteLimitExceeded === false
  );
}

function formatSubtitle(node: SnapshotNode, generatedAt: number): string {
  const parts: string[] = [node.state];
  if (node.activity?.currentTool) parts.push(node.activity.currentTool);
  if (node.activity?.turnCount !== undefined) parts.push(`${node.activity.turnCount} turns`);
  if (node.activity?.toolCount !== undefined) parts.push(`${node.activity.toolCount} tools`);
  if (node.startedAt !== undefined && generatedAt >= node.startedAt) {
    parts.push(formatDuration(generatedAt - node.startedAt));
  }
  return parts.join(" · ");
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
