import { z } from "zod";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ProviderEvent } from "../provider.js";

const identity = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const snapshotSchema = z
  .object({
    version: z.literal(1),
    id: identity,
    parentId: identity.nullable(),
    depth: z.number().int().min(1).max(16),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.enum(["running", "completed", "failed", "canceled"]),
    text: z
      .string()
      .max(32768)
      .refine((text) => [...text].length <= 16384),
    title: z
      .string()
      .min(1)
      .max(80)
      .refine((text) =>
        [...text].every((char) => char.codePointAt(0)! >= 32 && char.codePointAt(0)! !== 127),
      )
      .optional(),
    outputLimited: z.boolean().default(false),
    activitiesLimited: z.boolean().default(false),
    tools: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/)).max(32),
  })
  .strip();

type Snapshot = z.infer<typeof snapshotSchema>;

interface HermesSubagentsOptions {
  sessionId: string;
  cwd: string;
  emit(event: ProviderEvent): void;
}

/** Visibility-only provider child sessions, owned by the root ACP runtime. */
export class HermesSubagents {
  private readonly nodes = new Map<string, Snapshot>();
  private readonly waiting = new Map<string, Snapshot>();
  private childrenOmitted = false;

  constructor(private readonly options: HermesSubagentsOptions) {}

  accept(update: SessionUpdate): boolean {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return false;
    }
    if (this.acceptLimit(update)) return true;
    const envelope = z
      .object({ hermes: z.object({ subagentProgress: z.unknown() }) })
      .safeParse(update._meta);
    if (!envelope.success) return false;
    const parsed = snapshotSchema.safeParse(envelope.data.hermes.subagentProgress);
    // Leave unknown versions to the normal ACP tool-call fallback.
    if (!parsed.success) return false;
    const node = parsed.data;
    if (update.toolCallId !== `hermes-subagent:${node.id}`) return false;
    if ((node.depth === 1) !== (node.parentId === null) || node.parentId === node.id) return true;
    const previous = this.nodes.get(node.id) ?? this.waiting.get(node.id);
    if (
      previous &&
      (node.sequence <= previous.sequence ||
        previous.status !== "running" ||
        node.parentId !== previous.parentId ||
        node.depth !== previous.depth)
    )
      return true;
    if (!previous && this.nodes.size + this.waiting.size >= 64) return true;
    this.waiting.set(node.id, node);
    this.flush();
    return true;
  }

  private acceptLimit(update: SessionUpdate): boolean {
    if (
      (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") ||
      update.toolCallId !== "hermes-subagents:limit"
    )
      return false;
    const parsed = z
      .object({
        hermes: z.object({
          subagentLimit: z.object({
            version: z.literal(1),
            sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            limit: z.literal(64),
            childrenOmitted: z.literal(true),
          }),
        }),
      })
      .safeParse(update._meta);
    if (!parsed.success) return false;
    if (!this.childrenOmitted) {
      this.childrenOmitted = true;
      this.options.emit({
        type: "timeline.item",
        sessionId: this.options.sessionId,
        item: {
          type: "notification",
          id: "hermes-child-limit",
          level: "warning",
          message: "Additional Hermes subagents omitted: 64-child display limit reached.",
        },
      });
    }
    return true;
  }

  private flush(): void {
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const node of this.waiting.values()) {
        const parent = node.parentId === null ? null : this.nodes.get(node.parentId);
        if (parent === undefined) continue;
        this.waiting.delete(node.id);
        if (parent !== null && parent.depth + 1 !== node.depth) continue;
        this.publish(node);
        advanced = true;
      }
    }
  }

  private sessionId(id: string): string {
    return `${this.options.sessionId}:hermes:${id}`;
  }

  private publish(node: Snapshot): void {
    const sessionId = this.sessionId(node.id);
    const previous = this.nodes.get(node.id);
    if (!previous) {
      this.options.emit({
        type: "session.opened",
        sessionId,
        parentSessionId:
          node.parentId === null ? this.options.sessionId : this.sessionId(node.parentId),
        capabilities: [],
        restoration: "parent",
        cwd: this.options.cwd,
        title: node.title ?? "Hermes subagent",
        description: node.title ?? `Subagent ${node.id}`,
      });
    }
    this.nodes.set(node.id, node);
    for (const [index, name] of node.tools.entries()) {
      if (previous && index < previous.tools.length) continue;
      this.options.emit({
        type: "timeline.item",
        sessionId,
        item: {
          type: "notification",
          id: `hermes-tool:${index}`,
          level: "info",
          message: `Started tool: ${name}`,
        },
      });
    }
    if (node.text !== (previous?.text ?? "")) {
      this.options.emit({
        type: "timeline.item",
        sessionId,
        item: { type: "assistant_message", id: "hermes-public-output", text: node.text },
      });
    }
    for (const [limited, wasLimited, id, message] of [
      [
        node.outputLimited,
        previous?.outputLimited,
        "hermes-output-limit",
        "Public output limit reached (16,384 characters). This record is incomplete; later output is omitted.",
      ],
      [
        node.activitiesLimited,
        previous?.activitiesLimited,
        "hermes-activity-limit",
        "Activity limit reached (32 tool starts). This record is incomplete; later activity is omitted.",
      ],
    ] as const) {
      if (limited && !wasLimited)
        this.options.emit({
          type: "timeline.item",
          sessionId,
          item: { type: "notification", id, level: "warning", message },
        });
    }
    if (node.status !== previous?.status) {
      this.options.emit({
        type: "session.turn",
        sessionId,
        turnId: `hermes:${node.id}`,
        state: node.status === "running" ? "started" : node.status,
      });
    }
  }

  finish(status: "failed" | "canceled"): void {
    for (const node of this.nodes.values()) {
      if (node.status === "running") this.publish({ ...node, status });
    }
    this.waiting.clear();
  }
}
