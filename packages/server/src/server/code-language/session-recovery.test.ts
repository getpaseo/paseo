import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { CodeQuery, CodeQueryResult } from "@getpaseo/protocol/code-language";
import type { CancellationToken } from "vscode-languageserver-protocol";
import { CodeLanguageSession } from "./session.js";
import { TypeScriptProcess } from "./process.js";
import { signalProcessTree } from "../../utils/tree-kill.js";

type Runtime = NonNullable<ConstructorParameters<typeof CodeLanguageSession>[1]>;
type Process = ReturnType<Runtime["createProcess"]>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const hover: CodeQueryResult = { kind: "hover", text: "const value: 42", range: null };
class ProcessAdapter implements Process {
  readonly readiness = deferred<void>();
  readonly ready = this.readiness.promise;
  readonly queried = deferred<void>();
  readonly answer = deferred<CodeQueryResult>();
  readonly synced: Array<{ path: string; content: string; version: number }> = [];
  readonly closed: string[] = [];
  stopped = 0;
  token: CancellationToken | null = null;
  constructor(
    readonly exited: () => void,
    holdReady: boolean,
    holdQuery: boolean,
  ) {
    if (!holdReady) this.readiness.resolve();
    if (!holdQuery) this.answer.resolve(hover);
  }
  async sync(path: string, content: string, version: number) {
    this.synced.push({ path, content, version });
  }
  async close(path: string) {
    this.closed.push(path);
  }
  query(_query: CodeQuery, token: CancellationToken) {
    this.token = token;
    this.queried.resolve();
    return this.answer.promise;
  }
  stop() {
    this.stopped++;
    this.exited();
  }
}
class RuntimeAdapter implements Runtime {
  time = 0;
  holdReady = false;
  holdQuery = false;
  failStart = false;
  starts = 0;
  readonly created = deferred<ProcessAdapter>();
  readonly processes: ProcessAdapter[] = [];
  readonly timers = new Set<{ due: number; callback: () => void }>();
  now = () => this.time;
  schedule = (callback: () => void, delayMs: number) => {
    const timer = { due: this.time + delayMs, callback };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  };
  createProcess = (_cwd: string, _logger: pino.Logger, onExit: () => void) => {
    this.starts++;
    if (this.failStart) throw new Error("Compiler failed to launch");
    const process = new ProcessAdapter(onExit, this.holdReady, this.holdQuery);
    this.processes.push(process);
    this.created.resolve(process);
    return process;
  };
  advance(milliseconds: number) {
    this.time += milliseconds;
    for (const timer of Array.from(this.timers)) {
      if (timer.due <= this.time) {
        this.timers.delete(timer);
        timer.callback();
      }
    }
  }
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-language-recovery-"));
  const runtime = new RuntimeAdapter();
  const host = new CodeLanguageSession(pino({ level: "silent" }), runtime);
  cleanup.push(async () => {
    host.dispose();
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const query: CodeQuery = {
    cwd,
    path: join(cwd, "main.ts"),
    version: 1,
    operation: "hover",
    position: { line: 0, character: 6 },
  };
  await host.sync({ cwd, path: query.path, version: 1, content: "const value = 42;" });
  return { cwd, runtime, host, query };
}

test("settles mid-flight cancellation even when the process ignores it, then retires wedged work", async () => {
  const { host, runtime, query } = await fixture();
  runtime.holdQuery = true;
  const pending = host.query(query, "hover");
  const process = await runtime.created.promise;
  await process.queried.promise;
  await host.handle(
    { type: "code.language.cancel.request", requestId: "cancel", queryId: "hover" },
    () => {},
  );
  expect((await pending).result).toEqual({ kind: "stale" });
  expect(process.token?.isCancellationRequested).toBe(true);
  expect(process.stopped).toBe(0);
  runtime.advance(30000);
  expect(process.stopped).toBe(1);
  expect((await host.query(query)).result).toEqual({
    kind: "error",
    message: "Language server is restarting; retry shortly",
  });
  expect(runtime.starts).toBe(1);
  runtime.advance(5000);
  runtime.holdQuery = false;
  expect((await host.query(query)).result).toEqual(hover);
  expect(runtime.starts).toBe(2);
  expect(runtime.processes[1]?.synced[0]?.content).toBe("const value = 42;");
});

test("bounds startup without waiting for a noncooperative process and prevents late buffer replay", async () => {
  const { host, runtime, query } = await fixture();
  runtime.holdReady = true;
  const pending = host.query(query);
  const process = await runtime.created.promise;
  runtime.advance(30000);
  expect((await pending).result).toEqual({ kind: "error", message: "Language query timed out" });
  expect(process.stopped).toBe(1);
  process.readiness.resolve();
  await process.ready;
  expect(process.synced).toEqual([]);
  runtime.advance(5000);
  runtime.holdReady = false;
  expect((await host.query(query)).result).toEqual(hover);
});

test("returns a timeout error for a noncooperative in-flight query", async () => {
  const { host, runtime, query } = await fixture();
  runtime.holdQuery = true;
  const pending = host.query(query);
  const process = await runtime.created.promise;
  await process.queried.promise;
  runtime.advance(30000);
  expect((await pending).result).toEqual({ kind: "error", message: "Language query timed out" });
  expect(process.stopped).toBe(1);
});

test("backs off failed construction and retries with retained editor content", async () => {
  const { host, runtime, query } = await fixture();
  runtime.failStart = true;
  expect((await host.query(query)).result).toEqual({
    kind: "error",
    message: "Compiler failed to launch",
  });
  expect((await host.query(query)).result).toEqual({
    kind: "error",
    message: "Language server is restarting; retry shortly",
  });
  expect(runtime.starts).toBe(1);
  runtime.advance(5000);
  runtime.failStart = false;
  expect((await host.query(query)).result).toEqual(hover);
  expect(runtime.starts).toBe(2);
});

test("rejects late answers after a crash and backs off before replaying retained buffers", async () => {
  const { host, runtime, query } = await fixture();
  runtime.holdQuery = true;
  const pending = host.query(query);
  const process = await runtime.created.promise;
  await process.queried.promise;
  process.exited();
  process.answer.resolve(hover);
  expect((await pending).result).toEqual({ kind: "stale" });
  expect((await host.query(query)).result.kind).toBe("error");
  expect(runtime.starts).toBe(1);
  runtime.advance(5000);
  runtime.holdQuery = false;
  expect((await host.query(query)).result).toEqual(hover);
  expect(runtime.processes[1]?.synced[0]?.content).toBe("const value = 42;");
});

test("retains normalized workspace roots without losing buffers or the process generation", async () => {
  const { host, runtime, query, cwd } = await fixture();
  const first = await host.query(query);
  host.retainWorkspaces(new Set([`${cwd}/child/..`]));
  expect(await host.query(query)).toEqual(first);
  expect(runtime.starts).toBe(1);
  host.retainWorkspaces(new Set());
  expect(runtime.processes[0]?.stopped).toBe(1);
  await host.sync({ cwd, path: query.path, version: 1, content: "const value = 42;" });
  expect((await host.query(query)).generation).not.toBe(first.generation);
});

test("returns an error response instead of rejecting a query dispatched after disposal", async () => {
  const { host, query } = await fixture();
  host.dispose();
  const responses: unknown[] = [];
  await host.handle(
    { ...query, type: "code.language.query.request", requestId: "closed" },
    (response) => responses.push(response),
  );
  expect(responses).toEqual([
    {
      type: "code.language.query.response",
      payload: {
        requestId: "closed",
        version: 1,
        generation: "",
        result: { kind: "error", message: "Error: Language session closed" },
      },
    },
  ]);
});

test("recovers after a real language process exits without stopping its disposed connection again", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-language-exit-"));
  const runtime = new RuntimeAdapter();
  const exited = deferred<void>();
  const processes: TypeScriptProcess[] = [];
  const started = deferred<number>();
  const logger = pino(
    { level: "debug" },
    {
      write(chunk) {
        const record: { msg: string; pid: number } = JSON.parse(chunk);
        if (record.msg === "Language server started") started.resolve(record.pid);
      },
    },
  );
  const host = new CodeLanguageSession(logger, {
    now: runtime.now,
    schedule: runtime.schedule,
    createProcess: (root, processLogger, onExit) => {
      const process = new TypeScriptProcess(root, processLogger, () => {
        onExit();
        exited.resolve();
      });
      processes.push(process);
      return process;
    },
  });
  cleanup.push(async () => {
    host.dispose();
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const query: CodeQuery = {
    cwd,
    path: join(cwd, "main.ts"),
    version: 1,
    operation: "hover",
    position: { line: 0, character: 6 },
  };
  await host.sync({ cwd, path: query.path, version: 1, content: "const value = 42;" });
  const first = await host.query(query);
  expect(first.result).toMatchObject({ kind: "hover", text: "const value: 42" });
  const pid = await started.promise;
  await signalProcessTree({ pid, kill: (signal) => process.kill(pid, signal) }, "SIGTERM");
  await exited.promise;
  expect((await host.query(query)).result).toEqual({
    kind: "error",
    message: "Language server is restarting; retry shortly",
  });
  runtime.advance(5000);
  const recovered = await host.query(query);
  expect(recovered.result).toEqual(first.result);
  expect(recovered.generation).not.toBe(first.generation);
  expect(processes).toHaveLength(2);
});
