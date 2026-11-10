import { z } from "zod";
import type {
  AgentPersistenceHandle,
  AgentSession,
  AgentStreamEvent,
  ImportedTimelineEntry,
} from "../../agent-sdk-types.js";

const Notices = z.array(
  z.object({ major: z.union([z.literal(1), z.literal(2)]), timestamp: z.string().datetime() }),
);

function noticeEntries(major: 1 | 2, previous?: AgentPersistenceHandle): ImportedTimelineEntry[] {
  const notices = Notices.parse(previous?.metadata?.openCodeRuntimeNotices ?? []);
  if (notices.at(-1)?.major !== major) {
    notices.push({ major, timestamp: new Date().toISOString() });
  }
  return notices.map(({ major: recordedMajor, timestamp }) => ({
    timestamp,
    item: {
      type: "notification",
      level: "info",
      message: `This chat uses OpenCode v${recordedMajor}.`,
    },
  }));
}

// Dedicated history reads replay the same Paseo-owned notice rows an interactive
// resume would show, but only for display: a read never persists a new notice.
export function withOpenCodeRuntimeNoticeEvents(
  events: readonly AgentStreamEvent[],
  major: 1 | 2,
  previous?: AgentPersistenceHandle,
): AgentStreamEvent[] {
  const pending = noticeEntries(major, previous);
  const event = (entry: ImportedTimelineEntry): AgentStreamEvent => ({
    type: "timeline",
    provider: "opencode",
    ...entry,
  });
  const merged: AgentStreamEvent[] = [];
  for (const row of events) {
    while (
      row.type === "timeline" &&
      row.timestamp &&
      pending[0]?.timestamp &&
      pending[0].timestamp <= row.timestamp
    ) {
      merged.push(event(pending.shift()!));
    }
    merged.push(row);
  }
  for (const entry of pending) merged.push(event(entry));
  return merged;
}

// These rows belong to Paseo, not OpenCode's conversation. Keep their original
// timestamps in the persistence handle so history rebuilds preserve placement.
export function withOpenCodeRuntimeNotice(
  session: AgentSession,
  major: 1 | 2,
  previous?: AgentPersistenceHandle,
): AgentSession {
  const notices = Notices.parse(previous?.metadata?.openCodeRuntimeNotices ?? []);
  const added = notices.at(-1)?.major !== major;
  if (added) notices.push({ major, timestamp: new Date().toISOString() });
  const entries: ImportedTimelineEntry[] = notices.map(({ major: recordedMajor, timestamp }) => ({
    timestamp,
    item: {
      type: "notification",
      level: "info",
      message: `This chat uses OpenCode v${recordedMajor}.`,
    },
  }));
  const describePersistence = session.describePersistence.bind(session);
  const streamHistory = session.streamHistory.bind(session);
  return Object.assign(session, {
    initialTimeline: added ? entries.slice(-1) : [],
    describePersistence() {
      const handle = describePersistence();
      return (
        handle && { ...handle, metadata: { ...handle.metadata, openCodeRuntimeNotices: notices } }
      );
    },
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      const pending = [...entries];
      const event = (entry: ImportedTimelineEntry): AgentStreamEvent => ({
        type: "timeline",
        provider: "opencode",
        ...entry,
      });
      for await (const row of streamHistory()) {
        while (
          row.type === "timeline" &&
          row.timestamp &&
          pending[0]?.timestamp &&
          pending[0].timestamp <= row.timestamp
        ) {
          yield event(pending.shift()!);
        }
        yield row;
      }
      for (const entry of pending) yield event(entry);
    },
  });
}
