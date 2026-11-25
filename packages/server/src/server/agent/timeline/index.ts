import type { DaemonDatabase } from "../../database/index.js";
import { AgentTimeline } from "./internal/agent-timeline.js";
import { SqliteTimelineBackend } from "./internal/sqlite-backend.js";

export {
  AgentTimeline,
  TimelineClosedError,
  TimelineRewindBoundaryError,
  TimelineRewindPendingError,
  TimelineRewindTargetError,
  type TimelineAppendResult,
  type TimelineChild,
  type TimelineCommit,
  type TimelineEntry,
  type TimelineHead,
  type TimelineImportResult,
  type TimelineIngestResult,
  type TimelineReconcileResult,
  type TimelineRetirement,
  type TimelineRetirementCommit,
  type TimelineRewindCompletion,
  type TimelineRewindIntent,
  type TimelineRewindVerdict,
  type TimelineScope,
  type TimelineSeed,
} from "./internal/agent-timeline.js";
export { timelineSchema } from "./internal/sqlite-backend.js";

/** The daemon's timeline, stored in the daemon database. Open the database with `timelineSchema`. */
export function createStoredAgentTimeline(database: DaemonDatabase): AgentTimeline {
  return new AgentTimeline(new SqliteTimelineBackend(database));
}
