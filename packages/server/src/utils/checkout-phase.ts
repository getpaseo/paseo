import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type Phase =
  | "request"
  | "refresh"
  | "refresh_join"
  | "admission"
  | "facts"
  | "status"
  | "shortstat"
  | "ref_derived"
  | "forge"
  | "forge_resolve"
  | "forge_auth"
  | "forge_pr"
  | "forge_runner"
  | "forge_cache"
  | "forge_invalidate"
  | "response"
  | "git_queue"
  | "git_spawn"
  | "limit";
type Outcome = "start" | "ok" | "error" | "joined" | "skipped" | "truncated" | "deadline";
interface Fields {
  active?: number;
  pending?: number;
  force?: boolean;
  includeForge?: boolean;
  listenerCount?: number;
  snapshotPresent?: boolean;
  cacheHit?: boolean;
  alreadyActive?: boolean;
  addsWork?: boolean;
  queued?: boolean;
  operation?: "facts" | "status" | "shortstat" | "ref-derived" | "other-read";
}
interface JoinRefreshOptions {
  refresh: Refresh | undefined;
  alreadyActive: boolean;
  fields?: Fields;
}
interface PhaseOptions {
  name: Phase;
  fields?: Fields;
}
interface WithPhaseOptions<T> extends PhaseOptions {
  run: () => Promise<T>;
}
export interface CheckoutPhaseRow extends Fields {
  v: 1;
  requestId: string;
  phase: Phase;
  outcome: Outcome;
  spanId: string;
  refreshId?: string;
  cycleId?: string;
  elapsedMs: number;
  durationMs?: number;
}
type Event = Fields & {
  phase: Phase;
  outcome: Outcome;
  spanId: string;
  refreshId?: string;
  cycleId?: string;
  at: number;
  durationMs?: number;
};
type Sink = (row: CheckoutPhaseRow) => void;
interface Request {
  id: string;
  start: number;
  sink: Sink;
  rows: CheckoutPhaseRow[];
  count: number;
  slow: boolean;
  closed: boolean;
  refreshes: Set<Refresh>;
  observed: Map<string, number>;
}
interface Refresh {
  id: string;
  cycleId: string;
  subscribers: Set<Request>;
  active: Map<string, Event>;
  closed: boolean;
  truncated: boolean;
  timer: NodeJS.Timeout;
}
interface Context {
  request?: Request;
  refresh?: Refresh;
  operation?: Fields["operation"];
}
const context = new AsyncLocalStorage<Context>();
const now = () => Number(process.hrtime.bigint()) / 1e6;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emit(request: Request, event: Event) {
  if (request.closed || request.count >= 256) return;
  const { at, ...safe } = event;
  const elapsedMs = Math.max(0, at - request.start);
  const row: CheckoutPhaseRow = { v: 1, requestId: request.id, ...safe, elapsedMs };
  if (event.outcome === "start") request.observed.set(event.spanId, at);
  else if (row.durationMs !== undefined) {
    const observed = request.observed.get(event.spanId);
    request.observed.delete(event.spanId);
    if (observed === undefined) {
      delete row.durationMs;
      row.alreadyActive = true;
    } else if (row.durationMs > at - observed) {
      row.durationMs = Math.max(0, at - observed);
      row.alreadyActive = true;
    }
  }
  request.count++;
  if (request.count === 256) {
    Object.assign(row, { phase: "limit", outcome: "truncated" });
  }
  if (request.slow) {
    try {
      request.sink(row);
    } catch {}
  } else request.rows.push(row);
}

export interface TraceCheckoutRequestOptions<T> {
  id: string;
  sink: Sink;
  run: () => Promise<T>;
}

export async function traceCheckoutRequest<T>(options: TraceCheckoutRequestOptions<T>): Promise<T> {
  const { id, sink, run } = options;
  const request: Request = {
    id: uuid.test(id) ? id : randomUUID(),
    start: now(),
    sink,
    rows: [],
    count: 0,
    slow: false,
    closed: false,
    refreshes: new Set(),
    observed: new Map(),
  };
  const flush = () => {
    request.slow = true;
    for (const row of request.rows.splice(0)) {
      try {
        sink(row);
      } catch {}
    }
  };
  const slow = setTimeout(flush, 500);
  const deadline = setTimeout(() => {
    if (!request.slow) flush();
    emit(request, { phase: "limit", outcome: "deadline", spanId: randomUUID(), at: now() });
    close();
  }, 35_000);
  slow.unref();
  deadline.unref();
  function close() {
    request.closed = true;
    clearTimeout(slow);
    clearTimeout(deadline);
    for (const refresh of request.refreshes) refresh.subscribers.delete(request);
    request.refreshes.clear();
    request.rows.length = 0;
    request.observed.clear();
  }
  return context.run({ request }, async () => {
    const end = phase({ name: "request" });
    try {
      const result = await run();
      end("ok");
      return result;
    } catch (error) {
      end("error");
      throw error;
    } finally {
      close();
    }
  });
}

export function newRefresh(): Refresh {
  let refresh: Refresh;
  const timer = setTimeout(() => {
    for (const request of refresh.subscribers)
      emit(request, {
        phase: "limit",
        outcome: "deadline",
        spanId: randomUUID(),
        refreshId: refresh.id,
        cycleId: refresh.cycleId,
        at: now(),
      });
    closeRefresh(refresh);
  }, 35_000);
  refresh = {
    id: randomUUID(),
    cycleId: randomUUID(),
    subscribers: new Set(),
    active: new Map(),
    closed: false,
    truncated: false,
    timer,
  };
  refresh.timer.unref();
  return refresh;
}
export function joinRefresh(options: JoinRefreshOptions) {
  const { refresh, alreadyActive, fields = {} } = options;
  if (!refresh) return;
  const request = context.getStore()?.request;
  if (!request || request.closed || refresh.closed || refresh.subscribers.has(request)) return;
  refresh.subscribers.add(request);
  request.refreshes.add(refresh);
  emit(request, {
    phase: "refresh_join",
    outcome: "joined",
    spanId: randomUUID(),
    refreshId: refresh.id,
    cycleId: refresh.cycleId,
    at: now(),
    alreadyActive,
    ...fields,
  });
  for (const event of refresh.active.values())
    emit(request, { ...event, at: now(), alreadyActive: true });
  if (refresh.truncated)
    emit(request, {
      phase: "limit",
      outcome: "truncated",
      spanId: randomUUID(),
      refreshId: refresh.id,
      cycleId: refresh.cycleId,
      at: now(),
    });
}
export function runRefresh<T>(refresh: Refresh, run: () => T): T {
  return context.run({ refresh }, run);
}
export function nextRefreshCycle(refresh: Refresh) {
  refresh.cycleId = randomUUID();
}
export function closeRefresh(refresh: Refresh) {
  refresh.closed = true;
  clearTimeout(refresh.timer);
  for (const request of refresh.subscribers) request.refreshes.delete(refresh);
  refresh.subscribers.clear();
  refresh.active.clear();
}
export function phase(options: PhaseOptions) {
  const { name, fields = {} } = options;
  const store = context.getStore();
  const refresh = store?.refresh;
  const request = store?.request;
  if (!refresh && !request) return (_outcome: Outcome = "ok") => {};
  const start = now();
  const event: Event = {
    ...fields,
    ...(name === "git_queue" || name === "git_spawn"
      ? { operation: store?.operation ?? "other-read" }
      : {}),
    phase: name,
    outcome: "start",
    spanId: randomUUID(),
    refreshId: refresh?.id,
    cycleId: refresh?.cycleId,
    at: start,
  };
  const send = (row: Event) => {
    if (refresh && !refresh.closed)
      for (const subscriber of refresh.subscribers) emit(subscriber, row);
    else if (request) emit(request, row);
  };
  if (refresh && !refresh.closed) {
    if (refresh.active.size < 256) refresh.active.set(event.spanId, event);
    else refresh.truncated = true;
  }
  send(event);
  let ended = false;
  return (outcome: Outcome = "ok") => {
    if (ended) return;
    ended = true;
    refresh?.active.delete(event.spanId);
    const end = now();
    send({ ...event, outcome, at: end, durationMs: Math.max(0, end - start) });
  };
}
export async function withPhase<T>(options: WithPhaseOptions<T>): Promise<T> {
  const { name, run, fields } = options;
  const end = phase({ name, fields });
  try {
    const store = context.getStore();
    let operation = store?.operation;
    if (name === "ref_derived") operation = "ref-derived";
    else if (name === "facts" || name === "status" || name === "shortstat") operation = name;
    const result = await (store ? context.run({ ...store, operation }, run) : run());
    end();
    return result;
  } catch (error) {
    end("error");
    throw error;
  }
}

export function bindCheckoutPhase<T>(run: () => T): () => T {
  const store = context.getStore();
  return () => (store ? context.run(store, run) : run());
}
