import { scheduleAgentLastActivityFlush } from "./last-activity-scheduler";
import type {
  ActivityFlushHandle,
  AgentLastActivityCoalescer,
  AgentLastActivityCommitter,
} from "./types";

export function createAgentLastActivityCoalescer(): AgentLastActivityCoalescer {
  let pending = new Map<string, Date>();
  let scheduledFlush: ActivityFlushHandle | null = null;
  let committer: AgentLastActivityCommitter | null = null;

  const cancelScheduledFlush = () => {
    if (!scheduledFlush) {
      return;
    }
    scheduledFlush.cancel();
    scheduledFlush = null;
  };

  const flushNow = () => {
    cancelScheduledFlush();
    if (pending.size === 0) {
      return;
    }
    const updates = pending;
    pending = new Map();
    committer?.(updates);
  };

  const scheduleFlush = () => {
    if (scheduledFlush) {
      return;
    }
    scheduledFlush = scheduleAgentLastActivityFlush(() => {
      scheduledFlush = null;
      flushNow();
    });
  };

  return {
    setCommitter(nextCommitter) {
      committer = nextCommitter;
    },

    enqueue(agentId, timestamp) {
      const current = pending.get(agentId);
      if (current && current.getTime() >= timestamp.getTime()) {
        return;
      }
      pending.set(agentId, timestamp);
      scheduleFlush();
    },

    flushNow,

    deletePending(agentId) {
      pending.delete(agentId);
    },

    dispose() {
      cancelScheduledFlush();
      pending.clear();
      committer = null;
    },
  };
}
