import { z } from "zod";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { PiRuntimeEvent } from "./rpc-types.js";

const ASYNC_WIDGET_KEY = "subagent-async";
const ASYNC_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const ASYNC_SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
const ASYNC_SNAPSHOT_VERSION = 1;
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
    runs: z.array(SnapshotNodeSchema).max(64),
  })
  .passthrough();

type AsyncSnapshot = z.infer<typeof AsyncSnapshotSchema>;

export interface PiSubagentTarget {
  asyncId: string;
  childId?: string;
}

export interface PiSubagentsBridgeResult {
  handled: boolean;
  events: AgentStreamEvent[];
}

interface FlattenedNode {
  node: SnapshotNode;
  target: PiSubagentTarget;
  descriptorId: string;
  parentLabel?: string;
}

export class PiSubagentsBridge {
  private readonly targets = new Map<string, PiSubagentTarget>();
  private lastCompatibilityError: string | null = null;

  handleExtensionUiRequest(
    event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  ): PiSubagentsBridgeResult {
    if (event.method !== "setWidget" || event.widgetKey !== ASYNC_WIDGET_KEY) {
      return { handled: false, events: [] };
    }

    const line = firstWidgetLine(event.widgetLines);
    if (!line?.startsWith(ASYNC_WIDGET_PREFIX)) {
      return { handled: true, events: [] };
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
    return {
      handled: true,
      events: flattenSnapshot(parsed.data).map((entry) => {
        this.targets.set(entry.descriptorId, entry.target);
        return toProviderSubagentEvent(entry, parsed.data);
      }),
    };
  }

  resolveTarget(descriptorId: string): PiSubagentTarget | null {
    const target = this.targets.get(descriptorId);
    return target ? { ...target } : null;
  }

  private compatibilityFailure(message: string): PiSubagentsBridgeResult {
    if (this.lastCompatibilityError === message) {
      return { handled: true, events: [] };
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
    };
  }
}

function firstWidgetLine(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first = value[0];
  return typeof first === "string" ? first : null;
}

function flattenSnapshot(snapshot: AsyncSnapshot): FlattenedNode[] {
  const entries: FlattenedNode[] = [];
  for (const run of snapshot.runs) {
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

function mapStatus(state: SnapshotNode["state"]): "running" | "completed" | "failed" | "canceled" {
  if (state === "complete") return "completed";
  if (state === "stopped") return "canceled";
  if (state === "failed" || state === "paused" || state === "rejected") return "failed";
  return "running";
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
