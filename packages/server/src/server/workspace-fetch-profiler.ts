type WorkspaceFetchProfileMeta = Record<string, unknown>;

type AggregateRecord = {
  label: string;
  count: number;
  totalMs: number;
  maxMs: number;
};

type EventRecord = {
  label: string;
  durationMs: number;
  startedAt: string;
  meta: WorkspaceFetchProfileMeta | null;
};

const MAX_SLOWEST_EVENTS = 200;

const aggregates = new Map<string, AggregateRecord>();
const commandAggregates = new Map<string, AggregateRecord>();
const slowestEvents: EventRecord[] = [];

function isEnabled(): boolean {
  return process.env.PASEO_PROFILE_WORKSPACE_FETCH === "1";
}

function pushSlowEvent(event: EventRecord): void {
  slowestEvents.push(event);
  slowestEvents.sort((left, right) => right.durationMs - left.durationMs);
  if (slowestEvents.length > MAX_SLOWEST_EVENTS) {
    slowestEvents.length = MAX_SLOWEST_EVENTS;
  }
}

function recordAggregate(target: Map<string, AggregateRecord>, label: string, durationMs: number): void {
  const current = target.get(label);
  if (current) {
    current.count += 1;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    return;
  }

  target.set(label, {
    label,
    count: 1,
    totalMs: durationMs,
    maxMs: durationMs,
  });
}

function recordEvent(label: string, durationMs: number, meta?: WorkspaceFetchProfileMeta): void {
  recordAggregate(aggregates, label, durationMs);

  const command = typeof meta?.command === "string" ? meta.command : null;
  if (command) {
    recordAggregate(commandAggregates, command, durationMs);
  }

  pushSlowEvent({
    label,
    durationMs,
    startedAt: new Date().toISOString(),
    meta: meta ?? null,
  });
}

export async function profileWorkspaceFetch<T>(
  label: string,
  fn: () => Promise<T>,
  meta?: WorkspaceFetchProfileMeta,
): Promise<T> {
  if (!isEnabled()) {
    return fn();
  }

  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    recordEvent(label, performance.now() - startedAt, meta);
  }
}

export function resetWorkspaceFetchProfile(): void {
  aggregates.clear();
  commandAggregates.clear();
  slowestEvents.length = 0;
}

export function getWorkspaceFetchProfileSnapshot(): {
  enabled: boolean;
  generatedAt: string;
  totals: {
    aggregateCount: number;
    commandCount: number;
    sampledEventCount: number;
    totalMs: number;
  };
  aggregates: Array<AggregateRecord & { avgMs: number }>;
  commands: Array<AggregateRecord & { avgMs: number }>;
  slowest: EventRecord[];
} {
  const aggregateList = Array.from(aggregates.values())
    .map((entry) => ({
      ...entry,
      avgMs: entry.totalMs / Math.max(entry.count, 1),
    }))
    .sort((left, right) => right.totalMs - left.totalMs);

  const commandList = Array.from(commandAggregates.values())
    .map((entry) => ({
      ...entry,
      avgMs: entry.totalMs / Math.max(entry.count, 1),
    }))
    .sort((left, right) => right.totalMs - left.totalMs);

  return {
    enabled: isEnabled(),
    generatedAt: new Date().toISOString(),
    totals: {
      aggregateCount: aggregateList.length,
      commandCount: commandList.length,
      sampledEventCount: slowestEvents.length,
      totalMs: aggregateList.reduce((sum, entry) => sum + entry.totalMs, 0),
    },
    aggregates: aggregateList,
    commands: commandList,
    slowest: [...slowestEvents],
  };
}
