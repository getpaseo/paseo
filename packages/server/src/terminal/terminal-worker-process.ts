import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync, rmSync, writeSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { currentBootId } from "../server/pid-lock.js";
import { PRIVATE_FILE_MODE } from "../server/private-files.js";
import { createTerminalManager } from "./terminal-manager.js";
import { captureTerminalLines } from "./terminal-capture.js";
import { TerminalOutputCoalescer } from "./terminal-output-coalescer.js";
import type {
  TerminalExitInfo,
  TerminalSession,
  TerminalStateSnapshotOptions,
} from "./terminal.js";
import { attachFramedSocket, type FramedSocket } from "./terminal-worker-frames.js";
import { createTerminalWorkerProcessInspector } from "./terminal-worker-processes.js";
import {
  TERMINAL_WORKER_MARKER_ARG,
  terminalWorkerLogPath,
  terminalWorkerRecordPath,
  writeTerminalWorkerRecord,
  type TerminalWorkerRecord,
} from "./terminal-worker-record.js";
import { resolveTerminalWorkerSocketPath } from "./terminal-worker-socket-path.js";
import {
  TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV,
  TERMINAL_WORKER_PROTOCOL_VERSION,
  type TerminalWorkerHello,
  type TerminalWorkerHelloAck,
  type TerminalWorkerListResult,
  type TerminalWorkerRequest,
  type TerminalWorkerStateResult,
  type TerminalWorkerToParentMessage,
  type WorkerTerminalInfo,
} from "./terminal-worker-protocol.js";

// The terminal worker owns every PTY. It runs detached from the daemon (re-parented by the
// launcher below) so a daemon restart, crash or forced kill of the daemon's process tree does
// not take the terminals down, and it talks to whichever daemon controls it over an
// owner-only socket authenticated by the secret in its record.
//
// `--launch` runs the launcher: it starts the real worker detached, waits for it to listen,
// prints `{ pid, socketPath }` and exits, which leaves the worker parented to init.

const LAUNCH_ARG = "--launch";
const READY_TIMEOUT_MS = 15_000;
const HELLO_TIMEOUT_MS = 5_000;
// A freshly launched worker waits this long for its first controller before giving up.
const FIRST_CONTROLLER_TIMEOUT_MS = 30_000;
// While nobody controls it, the worker checks that its record still exists. A deleted record
// (a removed $PASEO_HOME) means no daemon can ever find these terminals again.
const ORPHAN_CHECK_INTERVAL_MS = 10_000;
const READY_FD = 3;

interface WorkerArgs {
  recordId: string;
  paseoHome: string;
  paseoVersion: string;
  // The copy under terminal-worker/ this worker runs from; absent when it runs from source.
  runtime: string | null;
}

function readArg(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) {
    throw new Error(`Terminal worker requires ${name}`);
  }
  return value;
}

function parseWorkerArgs(argv: string[], recordIdArg: string): WorkerArgs {
  return {
    recordId: readArg(argv, recordIdArg),
    paseoHome: readArg(argv, "--paseo-home"),
    paseoVersion: readArg(argv, "--paseo-version"),
    runtime: argv.includes("--runtime") ? readArg(argv, "--runtime") : null,
  };
}

// The protocol version this worker reports in its record and hello. Tests override it to stand
// up older and newer workers from one build.
function reportedProtocolVersion(): number {
  const override = process.env[TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV];
  if (override === undefined || override === "") return TERMINAL_WORKER_PROTOCOL_VERSION;
  const parsed = Number(override);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV} is not an integer: ${override}`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// Launcher
// ---------------------------------------------------------------------------------------------

function runLauncher(argv: string[]): void {
  const args = parseWorkerArgs(argv, "--record-id");
  const logFd = openSync(terminalWorkerLogPath(args.paseoHome), "a", PRIVATE_FILE_MODE);
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      TERMINAL_WORKER_MARKER_ARG,
      args.recordId,
      "--paseo-home",
      args.paseoHome,
      "--paseo-version",
      args.paseoVersion,
      ...(args.runtime ? ["--runtime", args.runtime] : []),
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", logFd, "pipe"],
      env: process.env,
      windowsHide: true,
    },
  );
  closeSync(logFd);

  let settled = false;
  let buffered = "";
  const finish = (code: number, output: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0 && child.exitCode === null && child.pid) {
      // A worker that never reported ready must not be left behind.
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    child.unref();
    (child.stdio[READY_FD] as NodeJS.ReadableStream & { destroy(): void }).destroy();
    // Exit from the write callback: a pipe write can still be pending when process.exit runs.
    (code === 0 ? process.stdout : process.stderr).write(output, () => process.exit(code));
  };
  const timer = setTimeout(() => {
    finish(1, `Terminal worker did not report ready within ${READY_TIMEOUT_MS}ms\n`);
  }, READY_TIMEOUT_MS);

  const readyStream = child.stdio[READY_FD] as NodeJS.ReadableStream;
  readyStream.setEncoding("utf8");
  readyStream.on("data", (chunk: string) => {
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline === -1) return;
    const line = buffered.slice(0, newline);
    if (line.startsWith("ready ")) {
      finish(0, `${JSON.stringify({ pid: child.pid, socketPath: line.slice("ready ".length) })}\n`);
      return;
    }
    finish(1, `${line.startsWith("error ") ? line.slice("error ".length) : line}\n`);
  });
  child.once("error", (error) => finish(1, `Cannot start terminal worker: ${error.message}\n`));
  child.once("exit", (code, signal) => {
    finish(1, `Terminal worker exited before it was ready (${signal ?? `code ${code}`})\n`);
  });
}

// ---------------------------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------------------------

type TerminalCreateRequest = Extract<TerminalWorkerRequest, { type: "createTerminal" }>;

function runWorker(argv: string[]): void {
  const args = parseWorkerArgs(argv, TERMINAL_WORKER_MARKER_ARG);
  const protocolVersion = reportedProtocolVersion();
  const manager = createTerminalManager();
  const inspector = createTerminalWorkerProcessInspector();
  const sessionsById = new Map<string, TerminalSession>();
  const unsubscribeByTerminalId = new Map<string, Array<() => void>>();
  const outputCoalescerByTerminalId = new Map<string, TerminalOutputCoalescer>();
  // A terminal is published (terminalCreated) only once its program is recorded. An exit that
  // arrives before then is held here and sent after the creation, so the controller never
  // receives an exit for a terminal it does not know yet.
  const exitsHeldDuringCreation = new Map<string, TerminalExitInfo | null>();
  const secret = randomBytes(32).toString("base64url");
  let record: TerminalWorkerRecord | null = null;
  let server: Server | null = null;
  let controller: FramedSocket | null = null;
  let everControlled = false;
  let exiting = false;

  interface InFlightTerminalCreateRequest {
    requestId: string;
    errorReported: boolean;
  }

  let inFlightTerminalCreateRequest: InFlightTerminalCreateRequest | null = null;

  // The conpty failure signal is process-scoped, not request-scoped. Serializing
  // creates keeps an async spawn failure attributable to exactly one request.
  let createTerminalQueue: Promise<void> = Promise.resolve();

  // node-pty completes its Windows conpty spawn asynchronously on a separate
  // conout worker thread. When that spawn fails (bad cwd, missing command, etc.)
  // it throws an exception there that cannot be caught at the call site and would
  // otherwise crash this worker process and sever every existing terminal.
  process.on("uncaughtException", (error) => {
    console.error("Terminal worker uncaught exception (kept alive):", error);
    reportInFlightTerminalCreateFailure(error);
  });

  function sendToController(message: TerminalWorkerToParentMessage): void {
    // With no controller the event is dropped; the headless terminal keeps the screen, and the
    // next daemon reads it through listTerminals.
    controller?.send(message);
  }

  function persistRecord(): void {
    if (!record || exiting) return;
    record = {
      ...record,
      terminals: record.terminals.filter((entry) => sessionsById.has(entry.id)),
    };
    writeTerminalWorkerRecord(args.paseoHome, record);
  }

  function removeOwnFiles(): void {
    rmSync(terminalWorkerRecordPath(args.paseoHome, process.pid), { force: true });
    if (record && process.platform !== "win32") {
      rmSync(record.socketPath, { force: true });
    }
  }

  function exitWorker(code: number): void {
    if (exiting) return;
    exiting = true;
    removeOwnFiles();
    server?.close();
    process.exit(code);
  }

  async function killEveryTerminalAndExit(): Promise<void> {
    const sessions = Array.from(sessionsById.values());
    await Promise.all(
      sessions.map((session) =>
        session.killAndWait().catch((error: unknown) => {
          console.error(`Terminal worker could not kill terminal ${session.id}:`, error);
        }),
      ),
    );
    exitWorker(0);
  }

  function exitIfIdle(): void {
    if (!controller && everControlled && sessionsById.size === 0) {
      exitWorker(0);
    }
  }

  function buildTerminalStateResult(
    session: TerminalSession | undefined,
    options?: TerminalStateSnapshotOptions,
  ): TerminalWorkerStateResult {
    if (!session) {
      return null;
    }
    return { ...session.getStateSnapshot(options), replayPreamble: session.getReplayPreamble() };
  }

  function toTerminalInfo(session: TerminalSession): WorkerTerminalInfo {
    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      workspaceId: session.workspaceId,
      ...(session.getTitle() ? { title: session.getTitle() } : {}),
      activity: session.getActivity(),
    };
  }

  function terminalWorkerErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Terminal worker request failed";
  }

  function reportInFlightTerminalCreateFailure(error: unknown): void {
    if (!inFlightTerminalCreateRequest || inFlightTerminalCreateRequest.errorReported) {
      return;
    }
    inFlightTerminalCreateRequest.errorReported = true;
    sendToController({
      type: "response",
      requestId: inFlightTerminalCreateRequest.requestId,
      ok: false,
      error: terminalWorkerErrorMessage(error),
    });
  }

  function clearTerminalSubscriptions(terminalId: string): void {
    const subscriptions = unsubscribeByTerminalId.get(terminalId);
    if (subscriptions) {
      for (const unsubscribe of subscriptions) {
        try {
          unsubscribe();
        } catch {
          // no-op
        }
      }
    }
    unsubscribeByTerminalId.delete(terminalId);
    const coalescer = outputCoalescerByTerminalId.get(terminalId);
    if (coalescer) {
      coalescer.dispose();
      outputCoalescerByTerminalId.delete(terminalId);
    }
  }

  function watchTerminal(session: TerminalSession): void {
    clearTerminalSubscriptions(session.id);

    // Coalesce pty output chunks into a single frame per ~5ms window so a burst of small
    // chunks no longer costs one socket write each. The batch carries the LAST chunk's
    // revision (the highest) so downstream snapshot replay dedup stays correct.
    let pendingOutputRevision: number | undefined;
    const outputCoalescer = new TerminalOutputCoalescer({
      timers: { setTimeout, clearTimeout },
      onFlush: ({ payload }) => {
        const revision = pendingOutputRevision;
        pendingOutputRevision = undefined;
        sendToController({
          type: "terminalMessage",
          terminalId: session.id,
          message: { type: "output", data: payload.toString("utf8"), revision },
          replayPreamble: session.getReplayPreamble(),
        });
      },
    });
    outputCoalescerByTerminalId.set(session.id, outputCoalescer);

    const unsubscribeMessage = session.subscribe(
      (message) => {
        if (message.type === "output") {
          pendingOutputRevision = message.revision;
          outputCoalescer.handle(message.data);
          return;
        }
        // Non-output messages (snapshot/snapshotReady/titleChange) must not jump
        // ahead of buffered output: flush the coalescer first, then forward.
        outputCoalescer.flush();
        sendToController({
          type: "terminalMessage",
          terminalId: session.id,
          message,
          replayPreamble: session.getReplayPreamble(),
        });
      },
      // Creation already sends an authoritative state in terminalCreated. A second
      // asynchronous state snapshot can arrive after the create response and
      // overwrite a resize issued immediately by the caller.
      { initialSnapshot: "ready" },
    );
    const unsubscribeExit = session.onExit((info) => {
      outputCoalescer.flush();
      clearTerminalSubscriptions(session.id);
      sessionsById.delete(session.id);
      persistRecord();
      if (exitsHeldDuringCreation.has(session.id)) {
        exitsHeldDuringCreation.set(session.id, info);
        return;
      }
      sendToController({
        type: "terminalExit",
        terminalId: session.id,
        info,
      });
      exitIfIdle();
    });
    const unsubscribeTitle = session.onTitleChange((title) => {
      outputCoalescer.flush();
      sendToController({
        type: "terminalTitleChange",
        terminalId: session.id,
        title,
      });
    });
    const unsubscribeCommandFinished = session.onCommandFinished((info) => {
      outputCoalescer.flush();
      sendToController({
        type: "terminalCommandFinished",
        terminalId: session.id,
        info,
      });
    });
    const unsubscribeActivity = session.onActivityChange((transition) => {
      sendToController({
        type: "terminalActivityChange",
        terminalId: session.id,
        activity: transition.activity,
        previous: transition.previous,
      });
    });

    unsubscribeByTerminalId.set(session.id, [
      unsubscribeMessage,
      unsubscribeExit,
      unsubscribeTitle,
      unsubscribeCommandFinished,
      unsubscribeActivity,
    ]);
  }

  // A terminal enters the record only with its program's birth time, so cleanup can always
  // tell the program from a later process that reuses its pid. A program that already exited
  // needs no entry; one whose birth time cannot be read is killed and the create fails.
  async function recordTerminalProgram(session: TerminalSession): Promise<void> {
    if (session.getExitInfo()) return;
    // The manager drops a session as soon as its program exits, so only a live one has a pid.
    const pid = manager.getTerminalProcessId(session.id);
    if (pid === null) {
      throw new Error(`Terminal ${session.id} has no program pid`);
    }
    const inspection = await inspector.inspect(pid);
    if (inspection.status === "not-found" || session.getExitInfo()) {
      return;
    }
    if (inspection.status === "error" || !inspection.snapshot.startedAt) {
      const reason =
        inspection.status === "error" ? errorMessage(inspection.error) : "no birth time reported";
      throw new Error(`Cannot identify terminal program ${pid}: ${reason}`);
    }
    if (!record) {
      throw new Error("Terminal worker record is not written yet");
    }
    record = {
      ...record,
      terminals: [
        ...record.terminals.filter((entry) => entry.id !== session.id),
        { id: session.id, pid, startedAt: inspection.snapshot.startedAt },
      ],
    };
    persistRecord();
  }

  function enqueueCreateTerminalRequest(message: TerminalCreateRequest): Promise<void> {
    const nextRequest = createTerminalQueue.then(() => handleCreateTerminalRequest(message));
    createTerminalQueue = nextRequest.catch(() => {});
    return nextRequest;
  }

  async function handleCreateTerminalRequest(message: TerminalCreateRequest): Promise<void> {
    const request: InFlightTerminalCreateRequest = {
      requestId: message.requestId,
      errorReported: false,
    };
    inFlightTerminalCreateRequest = request;
    try {
      const { workspaceId } = message.options;
      if (!workspaceId) {
        throw new Error("workspaceId is required");
      }
      const session = await manager.createTerminal({ ...message.options, workspaceId });
      if (request.errorReported) {
        session.kill();
        return;
      }
      sessionsById.set(session.id, session);
      exitsHeldDuringCreation.set(session.id, null);
      watchTerminal(session);
      try {
        await recordTerminalProgram(session);
      } catch (error) {
        exitsHeldDuringCreation.delete(session.id);
        clearTerminalSubscriptions(session.id);
        sessionsById.delete(session.id);
        await session.killAndWait().catch(() => undefined);
        throw error;
      }
      const initialSnapshot = session.getStateSnapshot();
      sendToController({
        type: "terminalCreated",
        terminal: toTerminalInfo(session),
        state: initialSnapshot.state,
      });
      sendToController({
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: {
          terminal: toTerminalInfo(session),
          state: initialSnapshot.state,
        },
      });
      const heldExit = exitsHeldDuringCreation.get(session.id);
      exitsHeldDuringCreation.delete(session.id);
      if (heldExit) {
        sendToController({ type: "terminalExit", terminalId: session.id, info: heldExit });
        exitIfIdle();
      }
    } catch (error) {
      reportInFlightTerminalCreateFailure(error);
    } finally {
      if (inFlightTerminalCreateRequest === request) {
        inFlightTerminalCreateRequest = null;
      }
    }
  }

  function listTerminals(): TerminalWorkerListResult {
    return Array.from(sessionsById.values()).map((session) => {
      // Buffered output is already in the headless state; flushing first keeps a later
      // batch from carrying bytes the snapshot already shows.
      outputCoalescerByTerminalId.get(session.id)?.flush();
      return {
        terminal: toTerminalInfo(session),
        state: session.getStateSnapshot().state,
        activityToken: manager.getTerminalActivityToken(session.id),
        replayPreamble: session.getReplayPreamble(),
      };
    });
  }

  async function handleRequest(message: TerminalWorkerRequest): Promise<void> {
    switch (message.type) {
      case "createTerminal": {
        await enqueueCreateTerminalRequest(message);
        return;
      }

      case "registerCwdEnv": {
        manager.registerCwdEnv({ cwd: message.cwd, env: message.env });
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }

      case "setActivity": {
        await manager.setTerminalActivity(message.terminalId, message.state);
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }

      case "clearAttention": {
        await manager.clearTerminalAttention(message.terminalId);
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }

      case "killTerminal": {
        manager.killTerminal(message.terminalId);
        // Removal is owned by session.onExit -> terminalExit; the parent mirror
        // clears contribution and emits terminalsChanged from that single path.
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }

      case "killTerminalAndWait": {
        await manager.killTerminalAndWait(message.terminalId, message.options);
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }

      case "getTerminalState": {
        // Flush buffered output before snapshotting: the headless state already includes it,
        // so if the coalescer emitted it afterward (in a batch carrying a revision past the
        // snapshot's) the controller's revision dedup wouldn't drop it and the client would
        // see the bytes twice. Flushing first sends them with a revision <= the snapshot's.
        outputCoalescerByTerminalId.get(message.terminalId)?.flush();
        sendToController({
          type: "response",
          requestId: message.requestId,
          ok: true,
          result: buildTerminalStateResult(
            manager.getTerminal(message.terminalId),
            message.options,
          ),
        });
        return;
      }

      case "captureTerminal": {
        const session = manager.getTerminal(message.terminalId);
        const result = session
          ? captureTerminalLines(session, {
              start: message.start,
              end: message.end,
              stripAnsi: message.stripAnsi,
            })
          : { lines: [], totalLines: 0 };
        sendToController({
          type: "response",
          requestId: message.requestId,
          ok: true,
          result,
        });
        return;
      }

      case "listTerminals": {
        sendToController({
          type: "response",
          requestId: message.requestId,
          ok: true,
          result: listTerminals(),
        });
        return;
      }

      case "shutdown": {
        const sessions = Array.from(sessionsById.values());
        await Promise.all(sessions.map((session) => session.killAndWait().catch(() => undefined)));
        // Exit once the response frame is flushed, so the requester sees the confirmation.
        const requester = controller;
        if (!requester) {
          exitWorker(0);
          return;
        }
        requester.send({ type: "response", requestId: message.requestId, ok: true }, () =>
          exitWorker(0),
        );
        return;
      }

      case "send": {
        const session = manager.getTerminal(message.terminalId);
        session?.send(message.message);
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }
    }
  }

  function isHello(message: unknown): message is TerminalWorkerHello {
    return (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "hello" &&
      typeof (message as { secret?: unknown }).secret === "string"
    );
  }

  function secretMatches(candidate: string): boolean {
    const expected = Buffer.from(secret, "utf8");
    const actual = Buffer.from(candidate, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function handleConnection(socket: Socket): void {
    let authenticated = false;
    socket.on("error", () => {
      // `close` follows; a broken controller socket only means no controller.
    });
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    const framed = attachFramedSocket(socket, (message) => {
      if (!authenticated) {
        clearTimeout(helloTimer);
        if (!isHello(message) || !secretMatches(message.secret)) {
          socket.destroy();
          return;
        }
        authenticated = true;
        // One controller at a time: a new authenticated connection replaces the old one.
        const previous = controller;
        controller = framed;
        everControlled = true;
        previous?.socket.destroy();
        const ack: TerminalWorkerHelloAck = {
          type: "helloAck",
          pid: process.pid,
          protocolVersion,
        };
        framed.send(ack);
        return;
      }
      if (framed !== controller) {
        return;
      }
      const request = message as TerminalWorkerRequest;
      void handleRequest(request).catch((error: unknown) => {
        sendToController({
          type: "response",
          requestId: request.requestId,
          ok: false,
          error: terminalWorkerErrorMessage(error),
        });
      });
    });
    socket.once("close", () => {
      clearTimeout(helloTimer);
      if (controller === framed) {
        controller = null;
        exitIfIdle();
      }
    });
  }

  function reportReady(line: string): void {
    try {
      writeSync(READY_FD, `${line}\n`);
      closeSync(READY_FD);
    } catch {
      // Started without a launcher pipe (tests that spawn the worker directly).
    }
  }

  async function start(): Promise<void> {
    const socketPath = resolveTerminalWorkerSocketPath({
      paseoHome: args.paseoHome,
      workerPid: process.pid,
    });
    if (process.platform !== "win32") {
      rmSync(socketPath, { force: true });
    }
    const listening = createServer(handleConnection);
    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(socketPath, () => {
        listening.off("error", reject);
        resolve();
      });
    });
    server = listening;
    if (process.platform !== "win32") {
      chmodSync(socketPath, PRIVATE_FILE_MODE);
    }

    const self = await inspector.inspect(process.pid);
    if (
      self.status !== "alive" ||
      !self.snapshot.startedAt ||
      !self.snapshot.commandLine?.includes(args.recordId)
    ) {
      const reason = self.status === "error" ? errorMessage(self.error) : "no usable snapshot";
      throw new Error(`Terminal worker cannot read its own process identity: ${reason}`);
    }
    record = {
      recordId: args.recordId,
      pid: process.pid,
      bootId: currentBootId(),
      createdAt: new Date().toISOString(),
      identity: { startedAt: self.snapshot.startedAt, commandLine: self.snapshot.commandLine },
      protocolVersion,
      paseoVersion: args.paseoVersion,
      socketPath,
      secret,
      runtime: args.runtime,
      terminals: [],
    };
    writeTerminalWorkerRecord(args.paseoHome, record);
    reportReady(`ready ${socketPath}`);

    setTimeout(() => {
      if (!everControlled && sessionsById.size === 0) exitWorker(0);
    }, FIRST_CONTROLLER_TIMEOUT_MS).unref();
    setInterval(() => {
      if (!controller && !existsSync(terminalWorkerRecordPath(args.paseoHome, process.pid))) {
        void killEveryTerminalAndExit();
      }
    }, ORPHAN_CHECK_INTERVAL_MS);
  }

  process.on("SIGTERM", () => {
    void killEveryTerminalAndExit();
  });

  start().catch((error: unknown) => {
    const message = errorMessage(error).replace(/\n/g, " | ");
    console.error(`Terminal worker failed to start: ${errorMessage(error)}`);
    reportReady(`error ${message}`);
    exitWorker(1);
  });
}

if (process.argv.includes(LAUNCH_ARG)) {
  runLauncher(process.argv.slice(2));
} else {
  runWorker(process.argv.slice(2));
}
