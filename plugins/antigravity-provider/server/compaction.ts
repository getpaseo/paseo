import type { AcpTurnObservation, AcpTurnObserver } from "@getpaseo/plugin/server/acp";
import { setTimeout as delay } from "node:timers/promises";
import { conversationDbPath, readConversationDb } from "./conversation-db.js";

// agy 1.5.14's steps table records a checkpoint only after the summary has been written.
// Remove the local observation once agy reports its lifecycle over ACP (google-antigravity/antigravity-cli#1509).
const userInput = 14;
const checkpoint = 23;
const done = 3;
const flushMs = 100;

export function observeCompaction(context: AcpTurnObservation): AcpTurnObserver | undefined {
  if (context.agentVersion !== "1.5.14") return undefined;
  const file = conversationDbPath(context);
  if (!file) return undefined;
  const floor = readConversationDb(
    file,
    (db) => db.prepare("SELECT coalesce(max(idx), -1) AS idx FROM steps").get()?.idx,
  );
  if (typeof floor !== "number") return undefined;

  let manualId = context.command === "compact" ? `${context.turnId}:compaction` : undefined;
  if (manualId) {
    context.emit({
      type: "compaction",
      id: manualId,
      status: "loading",
      trigger: "manual",
      liveOnly: true,
    });
  }

  let inputIndex: number | undefined;
  let reportedThrough = floor;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const scan = (): boolean => {
    if (stopped) return false;
    const rows = readConversationDb(file, (db) =>
      Array.from(
        db
          .prepare(`
      SELECT idx, step_type, status FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 64
    `)
          .iterate(floor),
      ),
    );
    if (!rows) return false;
    let published = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const { idx, step_type, status } = rows[i];
      if (typeof idx !== "number" || status !== done) continue;
      if (step_type === userInput) inputIndex ??= idx;
      if (
        step_type !== checkpoint ||
        inputIndex === undefined ||
        idx <= inputIndex ||
        idx <= reportedThrough
      )
        continue;
      context.emit({
        type: "compaction",
        id: manualId ?? `${context.turnId}:checkpoint:${idx}`,
        status: "completed",
        trigger: manualId ? "manual" : "auto",
      });
      manualId = undefined;
      reportedThrough = idx;
      published = true;
    }
    return published;
  };

  return {
    usage() {
      if (stopped) return;
      clearTimeout(timer);
      timer = undefined;
      if (scan()) return;
      timer = setTimeout(() => {
        timer = undefined;
        scan();
      }, flushMs);
      timer.unref();
    },
    async flush() {
      if (scan() || !manualId) return;
      // Native persistence can lag usage_update and the prompt reply. Do not wait indefinitely.
      await delay(flushMs);
      scan();
    },
    stop() {
      clearTimeout(timer);
      scan();
      stopped = true;
    },
  };
}
