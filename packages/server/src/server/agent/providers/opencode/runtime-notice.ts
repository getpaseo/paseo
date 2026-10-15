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
