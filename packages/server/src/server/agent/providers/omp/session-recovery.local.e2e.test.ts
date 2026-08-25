import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { OmpAgentClient } from "./agent.js";
import { OmpCliRuntime } from "./cli-runtime.js";
import type { OmpRuntimeSession } from "./runtime.js";

// Reproduction + fix verification for the OMP session-recovery defect. Needs a
// real `omp` on PATH (or OMP_COMMAND pointing at it), so it is a local-only e2e.
//
// Evidence is written to OMP_REPRO_EVIDENCE (default $TMPDIR/omp-repro-evidence.json)
// because the server vitest setup silences console output.
const OMP_COMMAND = process.env.OMP_COMMAND ?? "omp";

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Harness {
  runtime: OmpCliRuntime;
  children: ChildProcessWithoutNullStreams[];
  /** Resolves the next time the runtime spawns an omp process. */
  nextSpawn(): Promise<ChildProcessWithoutNullStreams>;
}

function createRuntime(): Harness {
  const children: ChildProcessWithoutNullStreams[] = [];
  let pendingSpawn: ((child: ChildProcessWithoutNullStreams) => void) | null = null;
  const runtime = new OmpCliRuntime({
    logger: pino({ level: "silent" }),
    command: [OMP_COMMAND],
    spawnProcess: (launch) => {
      const [command, ...args] = launch.argv;
      const spawned = spawn(command, args, {
        cwd: launch.cwd,
        stdio: "pipe",
        env: { ...process.env, ...launch.env },
      }) as ChildProcessWithoutNullStreams;
      children.push(spawned);
      const resolveSpawn = pendingSpawn;
      pendingSpawn = null;
      resolveSpawn?.(spawned);
      return spawned;
    },
  });
  return {
    runtime,
    children,
    nextSpawn: () => {
      const { promise, resolve } = Promise.withResolvers<ChildProcessWithoutNullStreams>();
      pendingSpawn = resolve;
      return promise;
    },
  };
}

// SIGKILL is what the Linux OOM killer sends.
async function oomKill(child: ChildProcessWithoutNullStreams): Promise<ProcessExit> {
  const { promise, resolve } = Promise.withResolvers<ProcessExit>();
  child.once("exit", (code, signal) => resolve({ code, signal }));
  child.kill("SIGKILL");
  return promise;
}

function nextMatchingEvent(
  session: AgentSession,
  predicate: (event: AgentStreamEvent) => boolean,
): Promise<AgentStreamEvent> {
  const { promise, resolve } = Promise.withResolvers<AgentStreamEvent>();
  const unsubscribe = session.subscribe((event) => {
    if (predicate(event)) {
      unsubscribe();
      resolve(event);
    }
  });
  return promise;
}

async function promptOutcome(session: OmpRuntimeSession, message: string): Promise<string> {
  return session.prompt(message).then(
    () => "ACCEPTED",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("OMP runtime session after its CLI process dies", () => {
  const evidence: Record<string, unknown> = { ompCommand: OMP_COMMAND };

  async function recordEvidence(): Promise<void> {
    await writeFile(
      process.env.OMP_REPRO_EVIDENCE ?? join(tmpdir(), "omp-repro-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
  }

  test("the dead runtime session rejects every later prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-session-recovery-"));
    const { runtime, children } = createRuntime();
    const session = await runtime.startSession({ cwd, protocolMode: "rpc-ui" });

    // The live session answers RPC before the kill.
    const state = await session.getState();
    expect(state.sessionId.length).toBeGreaterThan(0);

    const child = children.at(0);
    if (!child) throw new Error("omp child was never spawned");
    const exit = await oomKill(child);

    // The defect at the transport layer: the session object is still there but
    // every request is rejected from now on.
    const first = await promptOutcome(session, "hello");
    const second = await promptOutcome(session, "are you there?");

    evidence.deadRuntimeSession = {
      liveSessionId: state.sessionId,
      killedPid: child.pid ?? null,
      childExit: exit,
      promptAfterDeath: { first, second },
    };
    await recordEvidence();

    expect(first).toBe("OMP RPC process is closed");
    expect(second).toBe("OMP RPC process is closed");
  }, 60_000);

  test("relaunching against the same session file restores the same session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-session-resume-"));
    const sessionFile = join(cwd, "session.jsonl");
    const { runtime, children } = createRuntime();

    const first = await runtime.startSession({ cwd, protocolMode: "rpc-ui", session: sessionFile });
    const before = await first.getState();
    expect(before.sessionId.length).toBeGreaterThan(0);

    const firstChild = children.at(0);
    if (!firstChild) throw new Error("omp child was never spawned");
    const exit = await oomKill(firstChild);
    expect(await promptOutcome(first, "dead")).toBe("OMP RPC process is closed");

    // This is what the fix does automatically: relaunch against the same
    // session file and keep serving the same chat.
    const second = await runtime.startSession({
      cwd,
      protocolMode: "rpc-ui",
      session: sessionFile,
    });
    const after = await second.getState();

    evidence.relaunchKeepsSession = {
      sessionFile,
      sessionIdBeforeKill: before.sessionId,
      childExit: exit,
      sessionIdAfterRelaunch: after.sessionId,
      sameSession: before.sessionId === after.sessionId,
    };
    await recordEvidence();

    expect(after.sessionId).toBe(before.sessionId);
    await second.close();
  }, 90_000);

  test("the agent session recovers on the next prompt after an OOM kill", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-agent-recovery-"));
    const { runtime, children, nextSpawn } = createRuntime();
    const client = new OmpAgentClient({ logger: pino({ level: "silent" }), runtime });
    const session = await client.createSession({ provider: "omp", cwd });

    expect(children.length).toBe(1);
    const child = children.at(0);
    if (!child) throw new Error("omp child was never spawned");

    // The death is reported even though no turn was running.
    const reported = nextMatchingEvent(session, (event) => event.type === "turn_failed");
    const exit = await oomKill(child);
    const failure = await reported;

    // The next prompt in the SAME session relaunches the CLI instead of
    // rejecting forever. Arm the spawn watcher before prompting.
    const relaunched = nextSpawn();
    await session.startTurn("Reply with exactly: RECOVERED");
    const replacement = await relaunched;

    evidence.agentRecoversInPlace = {
      childExit: exit,
      reportedFailure: failure.type === "turn_failed" ? failure.error : null,
      runtimeProcessesSpawned: children.length,
      killedPid: child.pid ?? null,
      relaunchedPid: replacement.pid ?? null,
    };
    await recordEvidence();

    expect(children.length).toBe(2);
    expect(replacement.pid).not.toBe(child.pid);
    await session.close();
  }, 120_000);
});
