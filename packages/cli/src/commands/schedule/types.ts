export type ScheduleStatus = "active" | "paused" | "completed";

export type ScheduleCadence =
  | {
      type: "every";
      everyMs: number;
    }
  | {
      type: "cron";
      expression: string;
    };

export type ScheduleTarget =
  | {
      type: "self";
      agentId: string;
    }
  | {
      type: "agent";
      agentId: string;
    }
  | {
      type: "new-agent";
      config: {
        provider: string;
        cwd: string;
        modeId?: string;
        model?: string;
        thinkingOptionId?: string;
        title?: string | null;
        approvalPolicy?: string;
        sandboxMode?: string;
        networkAccess?: boolean;
        webSearch?: boolean;
      };
    };

export interface ScheduleRunRecord {
  id: string;
  scheduledFor: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "succeeded" | "failed";
  agentId: string | null;
  output: string | null;
  error: string | null;
}

export interface ScheduleRecord {
  id: string;
  name: string | null;
  prompt: string;
  cadence: ScheduleCadence;
  target: Exclude<ScheduleTarget, { type: "self" }>;
  status: ScheduleStatus;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  pausedAt: string | null;
  expiresAt: string | null;
  maxRuns: number | null;
  runs: ScheduleRunRecord[];
}

export interface ScheduleListItem {
  id: string;
  name: string | null;
  cadence: ScheduleCadence;
  target: Exclude<ScheduleTarget, { type: "self" }>;
  status: ScheduleStatus;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  pausedAt: string | null;
  expiresAt: string | null;
  maxRuns: number | null;
}

export interface CreateScheduleInput {
  prompt: string;
  name?: string;
  cadence: ScheduleCadence;
  target: ScheduleTarget;
  maxRuns?: number;
  expiresAt?: string;
  runOnCreate?: boolean;
}

export interface ScheduleCreatePayload {
  requestId: string;
  schedule: ScheduleListItem | null;
  error: string | null;
}

export interface ScheduleListPayload {
  requestId: string;
  schedules: ScheduleListItem[];
  error: string | null;
}

export interface ScheduleInspectPayload {
  requestId: string;
  schedule: ScheduleRecord | null;
  error: string | null;
}

export interface ScheduleLogsPayload {
  requestId: string;
  runs: ScheduleRunRecord[];
  error: string | null;
}

export interface SchedulePausePayload {
  requestId: string;
  schedule: ScheduleListItem | null;
  error: string | null;
}

export interface ScheduleResumePayload {
  requestId: string;
  schedule: ScheduleListItem | null;
  error: string | null;
}

export interface ScheduleDeletePayload {
  requestId: string;
  scheduleId: string;
  error: string | null;
}

export interface ScheduleRunOncePayload {
  requestId: string;
  schedule: ScheduleRecord | null;
  error: string | null;
}

export interface UpdateScheduleNewAgentConfig {
  provider?: string;
  model?: string | null;
  modeId?: string | null;
  cwd?: string;
}

export interface UpdateScheduleInput {
  id: string;
  name?: string | null;
  prompt?: string;
  cadence?: ScheduleCadence;
  newAgentConfig?: UpdateScheduleNewAgentConfig;
  maxRuns?: number | null;
  expiresAt?: string | null;
}

export interface ScheduleUpdatePayload {
  requestId: string;
  schedule: ScheduleRecord | null;
  error: string | null;
}

export interface ScheduleDaemonClient {
  scheduleCreate(input: CreateScheduleInput): Promise<ScheduleCreatePayload>;
  scheduleList(): Promise<ScheduleListPayload>;
  scheduleInspect(input: { id: string }): Promise<ScheduleInspectPayload>;
  scheduleLogs(input: { id: string }): Promise<ScheduleLogsPayload>;
  schedulePause(input: { id: string }): Promise<SchedulePausePayload>;
  scheduleResume(input: { id: string }): Promise<ScheduleResumePayload>;
  scheduleDelete(input: { id: string }): Promise<ScheduleDeletePayload>;
  scheduleRunOnce(input: { id: string }): Promise<ScheduleRunOncePayload>;
  scheduleUpdate(input: UpdateScheduleInput): Promise<ScheduleUpdatePayload>;
  close(): Promise<void>;
}
