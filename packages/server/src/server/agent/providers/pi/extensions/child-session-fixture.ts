import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStreamEvent, AgentTimelineItem } from "../../../agent-sdk-types.js";
import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";
import type { PiChildSessionScheduler } from "./child-session-follower.js";

/** One Pi session entry, in the shape a child session file appends. */
export function childEntry(role: "user" | "assistant", text: string, timestamp: string): string {
  return `${JSON.stringify({
    type: "message",
    timestamp,
    message: { role, content: [{ type: "text", text }] },
  })}\n`;
}

export function createChildSessionFile(initial = ""): string {
  const directory = mkdtempSync(join(tmpdir(), "paseo-pi-child-"));
  const file = join(directory, "child.jsonl");
  writeFileSync(file, initial);
  return file;
}

function itemText(item: AgentTimelineItem): string | null {
  return item.type === "user_message" ||
    item.type === "assistant_message" ||
    item.type === "reasoning"
    ? item.text
    : null;
}

/** The text of every mapped message, which is what a child pane renders. */
export function inputTexts(events: readonly ProviderSubagentInputEvent[]): string[] {
  return events
    .flatMap((event) => (event.type === "timeline" ? [itemText(event.item)] : []))
    .filter((text): text is string => text !== null);
}

export function streamTexts(events: readonly AgentStreamEvent[]): string[] {
  return events
    .flatMap((event) =>
      event.type === "provider_subagent" && event.event.type === "timeline"
        ? [itemText(event.event.item)]
        : [],
    )
    .filter((text): text is string => text !== null);
}

/** Scheduler a test drives by hand, so poll cadence never depends on wall-clock time. */
export class ManualChildSessionScheduler implements PiChildSessionScheduler {
  private pending: (() => void) | null = null;

  schedulePoll(callback: () => void, _delayMs: number): () => void {
    this.pending = callback;
    return () => {
      if (this.pending === callback) this.pending = null;
    };
  }

  get scheduled(): boolean {
    return this.pending !== null;
  }

  runScheduled(): void {
    const callback = this.pending;
    this.pending = null;
    callback?.();
  }
}
