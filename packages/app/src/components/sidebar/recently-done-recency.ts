import { resolveRecencyTickMs } from "@/hooks/sidebar-status-view-model";

const MS_PER_MINUTE = 60_000;

interface ClockSample {
  clientSentAt: number;
  clientReceivedAt: number;
  serverReceivedAt: number;
  serverSentAt: number;
}

interface RecencyTimingInput {
  active: boolean;
  isStatusMode: boolean;
  recentlyDoneWindowMinutes: number;
}

export function resolveRecencyTiming(input: RecencyTimingInput): {
  windowMs: number;
  tickIntervalMs: number | null;
} {
  const windowMs =
    input.active && input.isStatusMode ? input.recentlyDoneWindowMinutes * MS_PER_MINUTE : 0;
  return { windowMs, tickIntervalMs: resolveRecencyTickMs(windowMs) };
}

export function resolveServerClockOffsetMs(sample: ClockSample): number {
  const clientMidpoint = (sample.clientSentAt + sample.clientReceivedAt) / 2;
  const serverMidpoint = (sample.serverReceivedAt + sample.serverSentAt) / 2;
  return Math.round(serverMidpoint - clientMidpoint);
}
