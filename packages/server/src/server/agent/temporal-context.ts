export interface TemporalClock {
  wallTime(): Date;
  monotonicTime(): number;
  timeZone: string;
}

export function createTemporalClock(): TemporalClock {
  return {
    wallTime: () => new Date(),
    monotonicTime: () => performance.now(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function formatUserMessageTemporalContext(clock: TemporalClock): string {
  return `<paseo_temporal_context kind="user_message" received_at="${clock.wallTime().toISOString()}" timezone="${clock.timeZone}" />`;
}

export function formatToolResultTemporalContext(clock: TemporalClock, durationMs: number): string {
  const normalizedDurationMs = Math.max(0, Math.round(durationMs));
  return `<paseo_temporal_context kind="tool_result" completed_at="${clock.wallTime().toISOString()}" timezone="${clock.timeZone}" duration_ms="${normalizedDurationMs}" />`;
}
