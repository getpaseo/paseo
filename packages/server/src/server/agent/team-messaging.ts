export const TEAM_MESSAGE_MAX_LENGTH = 8000;
export const TEAM_MESSAGES_PER_SENDER_PER_MINUTE = 20;
export const TEAM_MESSAGES_PER_RUN = 200;

const MINUTE_MS = 60_000;

export interface TeamMessageLimits {
  perSenderPerMinute: number;
  perRun: number;
}

export type TeamMessageAdmission = { admitted: true } | { admitted: false; reason: string };

/**
 * Bounds send_team_message so two members cannot ping-pong forever. Counts live
 * in daemon memory and reset when the daemon restarts.
 */
export class TeamMessageLimiter {
  private readonly limits: TeamMessageLimits;
  private readonly now: () => number;
  private readonly sentBySender = new Map<string, number[]>();
  private readonly sentByRun = new Map<string, number>();

  constructor(options?: { limits?: Partial<TeamMessageLimits>; now?: () => number }) {
    this.limits = {
      perSenderPerMinute:
        options?.limits?.perSenderPerMinute ?? TEAM_MESSAGES_PER_SENDER_PER_MINUTE,
      perRun: options?.limits?.perRun ?? TEAM_MESSAGES_PER_RUN,
    };
    this.now = options?.now ?? Date.now;
  }

  /** Admits and counts one message, or says which limit refused it. */
  admit(input: { senderId: string; runId: string }): TeamMessageAdmission {
    const now = this.now();
    const recent = (this.sentBySender.get(input.senderId) ?? []).filter(
      (sentAt) => now - sentAt < MINUTE_MS,
    );
    const runCount = this.sentByRun.get(input.runId) ?? 0;
    if (runCount >= this.limits.perRun) {
      return {
        admitted: false,
        reason: `This team run reached its limit of ${this.limits.perRun} team messages. Report back to your parent instead of messaging further.`,
      };
    }
    if (recent.length >= this.limits.perSenderPerMinute) {
      this.sentBySender.set(input.senderId, recent);
      return {
        admitted: false,
        reason: `Rate limit: at most ${this.limits.perSenderPerMinute} team messages per sender per minute. Wait before sending again.`,
      };
    }
    recent.push(now);
    this.sentBySender.set(input.senderId, recent);
    this.sentByRun.set(input.runId, runCount + 1);
    return { admitted: true };
  }
}

/** Shared by every tool catalog in the daemon process. */
export const defaultTeamMessageLimiter = new TeamMessageLimiter();
