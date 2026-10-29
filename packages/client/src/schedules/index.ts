import type {
  CreateScheduleOptions,
  DaemonClient,
  InspectScheduleOptions,
  UpdateScheduleOptions,
} from "../daemon-client.js";

export type PaseoScheduleCreateOptions = CreateScheduleOptions;
export type PaseoScheduleInspectOptions = InspectScheduleOptions;
export type PaseoScheduleUpdateOptions = UpdateScheduleOptions;
export type PaseoScheduleCreateResult = Awaited<ReturnType<DaemonClient["scheduleCreate"]>>;
export type PaseoScheduleListResult = Awaited<ReturnType<DaemonClient["scheduleList"]>>;
export type PaseoScheduleInspectResult = Awaited<ReturnType<DaemonClient["scheduleInspect"]>>;
export type PaseoScheduleLogsResult = Awaited<ReturnType<DaemonClient["scheduleLogs"]>>;
export type PaseoSchedulePauseResult = Awaited<ReturnType<DaemonClient["schedulePause"]>>;
export type PaseoScheduleResumeResult = Awaited<ReturnType<DaemonClient["scheduleResume"]>>;
export type PaseoScheduleDeleteResult = Awaited<ReturnType<DaemonClient["scheduleDelete"]>>;
export type PaseoScheduleRunOnceResult = Awaited<ReturnType<DaemonClient["scheduleRunOnce"]>>;
export type PaseoScheduleUpdateResult = Awaited<ReturnType<DaemonClient["scheduleUpdate"]>>;

/** Host-owned schedules persist independently of the calling client or plugin. */
export interface PaseoScheduleActions {
  /** Results carry daemon errors in `error`; transport failures reject. */
  create(options: PaseoScheduleCreateOptions): Promise<PaseoScheduleCreateResult>;
  list(requestId?: string): Promise<PaseoScheduleListResult>;
  inspect(options: PaseoScheduleInspectOptions): Promise<PaseoScheduleInspectResult>;
  logs(options: PaseoScheduleInspectOptions): Promise<PaseoScheduleLogsResult>;
  pause(options: PaseoScheduleInspectOptions): Promise<PaseoSchedulePauseResult>;
  resume(options: PaseoScheduleInspectOptions): Promise<PaseoScheduleResumeResult>;
  delete(options: PaseoScheduleInspectOptions): Promise<PaseoScheduleDeleteResult>;
  runOnce(options: PaseoScheduleInspectOptions): Promise<PaseoScheduleRunOnceResult>;
  update(options: PaseoScheduleUpdateOptions): Promise<PaseoScheduleUpdateResult>;
}

/** @package */
export function createScheduleActions(daemonClient: DaemonClient): PaseoScheduleActions {
  return {
    create: (options) => daemonClient.scheduleCreate(options),
    list: (requestId) => daemonClient.scheduleList(requestId),
    inspect: (options) => daemonClient.scheduleInspect(options),
    logs: (options) => daemonClient.scheduleLogs(options),
    pause: (options) => daemonClient.schedulePause(options),
    resume: (options) => daemonClient.scheduleResume(options),
    delete: (options) => daemonClient.scheduleDelete(options),
    runOnce: (options) => daemonClient.scheduleRunOnce(options),
    update: (options) => daemonClient.scheduleUpdate(options),
  };
}
