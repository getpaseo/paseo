import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Logger } from "pino";
import { curateAgentActivity } from "./agent/activity-curator.js";
import type { AgentManager } from "./agent/agent-manager.js";
import { getStructuredAgentResponse } from "./agent/agent-response-loop.js";
import type {
  AgentPromptInput,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentProvider,
} from "./agent/agent-sdk-types.js";

const execFileAsync = promisify(execFile);
const LOOP_ID_LENGTH = 8;
const DEFAULT_LOOP_PROVIDER: AgentProvider = "claude";
const MAX_VERIFY_OUTPUT_BYTES = 64 * 1024;

const LoopVerifyPromptSchema = z.object({
  passed: z.boolean(),
  reason: z.string().min(1),
});

const LoopLogEntrySchema = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  iteration: z.number().int().positive().nullable(),
  source: z.enum(["loop", "worker", "verifier", "verify-check"]),
  level: z.enum(["info", "error"]),
  text: z.string(),
});

const LoopVerifyCheckResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  passed: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
});

const LoopVerifyPromptResultSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
  verifierAgentId: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
});

const LoopIterationRecordSchema = z.object({
  index: z.number().int().positive(),
  workerAgentId: z.string().nullable(),
  workerStartedAt: z.string(),
  workerCompletedAt: z.string().nullable(),
  verifierAgentId: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "stopped"]),
  workerOutcome: z.enum(["completed", "failed", "canceled"]).nullable(),
  failureReason: z.string().nullable(),
  verifyChecks: z.array(LoopVerifyCheckResultSchema),
  verifyPrompt: LoopVerifyPromptResultSchema.nullable(),
});

const LoopRecordSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prompt: z.string(),
  cwd: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  workerProvider: z.string().nullable(),
  workerModel: z.string().nullable(),
  verifierProvider: z.string().nullable(),
  verifierModel: z.string().nullable(),
  verifyPrompt: z.string().nullable(),
  verifyChecks: z.array(z.string()),
  archive: z.boolean(),
  sleepMs: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive().nullable(),
  maxTimeMs: z.number().int().positive().nullable(),
  status: z.enum(["running", "succeeded", "failed", "stopped"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  stopRequestedAt: z.string().nullable(),
  iterations: z.array(LoopIterationRecordSchema),
  logs: z.array(LoopLogEntrySchema),
  nextLogSeq: z.number().int().positive(),
  activeIteration: z.number().int().positive().nullable(),
  activeWorkerAgentId: z.string().nullable(),
  activeVerifierAgentId: z.string().nullable(),
});

const StoredLoopsSchema = z.array(LoopRecordSchema);

export type LoopStatus = z.infer<typeof LoopRecordSchema>["status"];
export type LoopLogEntry = z.infer<typeof LoopLogEntrySchema>;
export type LoopVerifyCheckResult = z.infer<typeof LoopVerifyCheckResultSchema>;
export type LoopVerifyPromptResult = z.infer<typeof LoopVerifyPromptResultSchema>;
export type LoopIterationRecord = z.infer<typeof LoopIterationRecordSchema>;
export type LoopRecord = z.infer<typeof LoopRecordSchema>;

export interface LoopRunOptions {
  prompt: string;
  cwd: string;
  provider?: AgentProvider;
  model?: string;
  workerProvider?: AgentProvider;
  workerModel?: string;
  verifierProvider?: AgentProvider;
  verifierModel?: string;
  verifyPrompt?: string;
  verifyChecks?: string[];
  archive?: boolean;
  name?: string;
  sleepMs?: number;
  maxIterations?: number;
  maxTimeMs?: number;
}

export interface LoopListItem {
  id: string;
  name: string | null;
  status: LoopStatus;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  activeIteration: number | null;
}

export interface LoopLogsResult {
  loop: LoopRecord;
  entries: LoopLogEntry[];
  nextCursor: number;
}

interface RunningLoopState {
  abortController: AbortController;
  promise: Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cloneLoop(record: LoopRecord): LoopRecord {
  return LoopRecordSchema.parse(record);
}

function createLoopId(): string {
  return randomUUID().replace(/-/g, "").slice(0, LOOP_ID_LENGTH);
}

function normalizeName(name: string | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

function normalizePrompt(value: string | undefined, field: string): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} cannot be empty`);
  }
  return trimmed;
}

function ensurePositiveInteger(value: number | undefined, field: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function ensureNonNegativeInteger(value: number | undefined, field: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function buildWorkerTitle(loop: LoopRecord, iterationIndex: number): string {
  const prefix = loop.name ?? loop.id;
  return `${prefix} [loop ${iterationIndex} worker]`;
}

function buildVerifierTitle(loop: LoopRecord, iterationIndex: number): string {
  const prefix = loop.name ?? loop.id;
  return `${prefix} [loop ${iterationIndex} verifier]`;
}

function formatStreamLog(event: AgentStreamEvent): string | null {
  switch (event.type) {
    case "timeline": {
      const rendered = curateAgentActivity([event.item]);
      return rendered === "No activity to display." ? null : rendered;
    }
    case "turn_failed":
      return `[Turn Failed] ${event.error}`;
    case "turn_canceled":
      return `[Turn Canceled] ${event.reason}`;
    case "permission_requested":
      return `[Permission Requested] ${event.request.name}`;
    case "permission_resolved":
      return `[Permission Resolved] ${event.requestId}`;
    default:
      return null;
  }
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("Loop aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.message === "Loop aborted") {
    return true;
  }
  return false;
}

async function runVerifyCheck(options: {
  cwd: string;
  command: string;
}): Promise<LoopVerifyCheckResult> {
  const startedAt = nowIso();
  try {
    const result = await execFileAsync("/bin/sh", ["-lc", options.command], {
      cwd: options.cwd,
      maxBuffer: MAX_VERIFY_OUTPUT_BYTES,
    });
    return {
      command: options.command,
      exitCode: 0,
      passed: true,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      startedAt,
      completedAt: nowIso(),
    };
  } catch (error) {
    const childError = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      command: options.command,
      exitCode: typeof childError.code === "number" ? childError.code : 1,
      passed: false,
      stdout: childError.stdout ?? "",
      stderr: childError.stderr ?? "",
      startedAt,
      completedAt: nowIso(),
    };
  }
}

export class LoopService {
  private readonly storePath: string;
  private readonly logger: Logger;
  private loaded = false;
  private readonly loops = new Map<string, LoopRecord>();
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly running = new Map<string, RunningLoopState>();

  constructor(
    private readonly options: {
      paseoHome: string;
      agentManager: AgentManager;
      logger: Logger;
    },
  ) {
    this.storePath = path.join(options.paseoHome, "loops", "loops.json");
    this.logger = options.logger.child({ module: "loop-service" });
  }

  async initialize(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loops.clear();
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      const parsed = StoredLoopsSchema.parse(JSON.parse(raw));
      for (const record of parsed) {
        if (record.status === "running") {
          const recovered = cloneLoop(record);
          recovered.status = "stopped";
          recovered.updatedAt = nowIso();
          recovered.completedAt = recovered.updatedAt;
          recovered.stopRequestedAt = recovered.updatedAt;
          recovered.activeIteration = null;
          recovered.activeWorkerAgentId = null;
          recovered.activeVerifierAgentId = null;
          this.appendLog(recovered, {
            iteration: null,
            source: "loop",
            level: "error",
            text: "Loop was interrupted by daemon restart.",
          });
          const lastIteration = recovered.iterations.at(-1);
          if (lastIteration && lastIteration.status === "running") {
            lastIteration.status = "stopped";
            lastIteration.failureReason = "Daemon restarted";
            lastIteration.workerCompletedAt = recovered.updatedAt;
          }
          this.loops.set(recovered.id, recovered);
          continue;
        }
        this.loops.set(record.id, record);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, storePath: this.storePath }, "Failed to load loops");
      }
    }
    this.loaded = true;
    await this.persist();
  }

  async runLoop(input: LoopRunOptions): Promise<LoopRecord> {
    await this.initialize();
    const prompt = normalizePrompt(input.prompt, "prompt");
    if (!prompt) {
      throw new Error("prompt cannot be empty");
    }
    const verifyPrompt = normalizePrompt(input.verifyPrompt, "verifyPrompt");
    const verifyChecks = (input.verifyChecks ?? []).map((command) => {
      const trimmed = command.trim();
      if (!trimmed) {
        throw new Error("verifyChecks cannot contain empty commands");
      }
      return trimmed;
    });
    if (!verifyPrompt && verifyChecks.length === 0) {
      throw new Error("Loop requires --verify or at least one --verify-check");
    }

    const createdAt = nowIso();
    const record = LoopRecordSchema.parse({
      id: createLoopId(),
      name: normalizeName(input.name),
      prompt,
      cwd: path.resolve(input.cwd),
      provider: input.provider ?? DEFAULT_LOOP_PROVIDER,
      model: normalizePrompt(input.model, "model"),
      workerProvider: input.workerProvider ?? null,
      workerModel: normalizePrompt(input.workerModel, "workerModel"),
      verifierProvider: input.verifierProvider ?? null,
      verifierModel: normalizePrompt(input.verifierModel, "verifierModel"),
      verifyPrompt,
      verifyChecks,
      archive: input.archive ?? false,
      sleepMs: ensureNonNegativeInteger(input.sleepMs, "sleepMs"),
      maxIterations: ensurePositiveInteger(input.maxIterations, "maxIterations"),
      maxTimeMs: ensurePositiveInteger(input.maxTimeMs, "maxTimeMs"),
      status: "running",
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      completedAt: null,
      stopRequestedAt: null,
      iterations: [],
      logs: [],
      nextLogSeq: 1,
      activeIteration: null,
      activeWorkerAgentId: null,
      activeVerifierAgentId: null,
    });

    this.loops.set(record.id, record);
    this.appendLog(record, {
      iteration: null,
      source: "loop",
      level: "info",
      text: `Loop created in ${record.cwd}`,
    });
    await this.persist();

    const abortController = new AbortController();
    const promise = this.executeLoop(record.id, abortController.signal).finally(() => {
      this.running.delete(record.id);
    });
    this.running.set(record.id, { abortController, promise });

    return cloneLoop(record);
  }

  async listLoops(): Promise<LoopListItem[]> {
    await this.initialize();
    return Array.from(this.loops.values())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => ({
        id: record.id,
        name: record.name,
        status: record.status,
        cwd: record.cwd,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        activeIteration: record.activeIteration,
      }));
  }

  async inspectLoop(idOrPrefix: string): Promise<LoopRecord> {
    await this.initialize();
    const loop = this.requireLoop(idOrPrefix);
    return cloneLoop(loop);
  }

  async getLoopLogs(idOrPrefix: string, afterSeq = 0): Promise<LoopLogsResult> {
    await this.initialize();
    const loop = this.requireLoop(idOrPrefix);
    const entries = loop.logs.filter((entry) => entry.seq > afterSeq);
    return {
      loop: cloneLoop(loop),
      entries: entries.map((entry) => LoopLogEntrySchema.parse(entry)),
      nextCursor: loop.nextLogSeq - 1,
    };
  }

  async stopLoop(idOrPrefix: string): Promise<LoopRecord> {
    await this.initialize();
    const loop = this.requireLoop(idOrPrefix);
    if (loop.status !== "running") {
      return cloneLoop(loop);
    }
    const running = this.running.get(loop.id);
    loop.stopRequestedAt = loop.stopRequestedAt ?? nowIso();
    loop.updatedAt = loop.stopRequestedAt;
    this.appendLog(loop, {
      iteration: loop.activeIteration,
      source: "loop",
      level: "info",
      text: "Stop requested.",
    });
    await this.persist();

    if (running) {
      running.abortController.abort(new Error("Loop aborted"));
      if (loop.activeWorkerAgentId) {
        await this.options.agentManager.cancelAgentRun(loop.activeWorkerAgentId).catch(() => {});
      }
      if (loop.activeVerifierAgentId) {
        await this.options.agentManager.cancelAgentRun(loop.activeVerifierAgentId).catch(() => {});
      }
      await running.promise.catch(() => {});
    } else {
      loop.status = "stopped";
      loop.completedAt = nowIso();
      loop.updatedAt = loop.completedAt;
      await this.persist();
    }

    return cloneLoop(loop);
  }

  private async executeLoop(loopId: string, signal: AbortSignal): Promise<void> {
    const loop = this.requireLoop(loopId);
    const deadline = loop.maxTimeMs ? Date.now() + loop.maxTimeMs : null;

    try {
      for (let index = 1; ; index += 1) {
        if (signal.aborted) {
          throw new Error("Loop aborted");
        }
        if (loop.maxIterations && index > loop.maxIterations) {
          this.finishLoop(loop, "failed", `Reached max iterations (${loop.maxIterations}).`);
          return;
        }
        if (deadline !== null && Date.now() > deadline) {
          this.finishLoop(loop, "failed", `Reached max time (${loop.maxTimeMs}ms).`);
          return;
        }

        const iteration = LoopIterationRecordSchema.parse({
          index,
          workerAgentId: null,
          workerStartedAt: nowIso(),
          workerCompletedAt: null,
          verifierAgentId: null,
          status: "running",
          workerOutcome: null,
          failureReason: null,
          verifyChecks: [],
          verifyPrompt: null,
        });
        loop.iterations.push(iteration);
        loop.activeIteration = index;
        loop.updatedAt = nowIso();
        this.appendLog(loop, {
          iteration: index,
          source: "loop",
          level: "info",
          text: `Starting iteration ${index}.`,
        });
        await this.persist();

        const workerPassed = await this.runWorkerIteration(loop, iteration, signal);
        if (signal.aborted) {
          throw new Error("Loop aborted");
        }
        if (!workerPassed) {
          iteration.status = iteration.status === "stopped" ? "stopped" : "failed";
        } else {
          const verificationPassed = await this.runVerification(loop, iteration, signal);
          if (verificationPassed) {
            iteration.status = "succeeded";
            this.finishLoop(loop, "succeeded", `Iteration ${index} passed verification.`);
            return;
          }
          if (iteration.status === "running") {
            iteration.status = "failed";
          }
        }

        loop.activeIteration = null;
        loop.activeWorkerAgentId = null;
        loop.activeVerifierAgentId = null;
        loop.updatedAt = nowIso();
        await this.persist();

        if (loop.sleepMs > 0) {
          this.appendLog(loop, {
            iteration: index,
            source: "loop",
            level: "info",
            text: `Sleeping ${loop.sleepMs}ms before next iteration.`,
          });
          await this.persist();
          await sleepWithAbort(loop.sleepMs, signal);
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        this.finishLoop(loop, "stopped", "Loop stopped.");
        const iteration = loop.activeIteration
          ? loop.iterations.find((candidate) => candidate.index === loop.activeIteration)
          : null;
        if (iteration && iteration.status === "running") {
          iteration.status = "stopped";
          iteration.failureReason = "Loop stopped";
          iteration.workerCompletedAt = nowIso();
        }
        await this.persist();
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, loopId }, "Loop execution failed");
      this.finishLoop(loop, "failed", message);
      const iteration = loop.activeIteration
        ? loop.iterations.find((candidate) => candidate.index === loop.activeIteration)
        : null;
      if (iteration && iteration.status === "running") {
        iteration.status = "failed";
        iteration.failureReason = message;
        iteration.workerCompletedAt = nowIso();
      }
      await this.persist();
    }
  }

  private async runWorkerIteration(
    loop: LoopRecord,
    iteration: LoopIterationRecord,
    signal: AbortSignal,
  ): Promise<boolean> {
    const agent = await this.options.agentManager.createAgent(this.buildWorkerConfig(loop, iteration));
    iteration.workerAgentId = agent.id;
    loop.activeWorkerAgentId = agent.id;
    loop.updatedAt = nowIso();
    await this.persist();

    const unsubscribe = this.options.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_stream") {
          return;
        }
        const text = formatStreamLog(event.event);
        if (!text) {
          return;
        }
        this.appendLog(loop, {
          iteration: iteration.index,
          source: "worker",
          level: event.event.type === "turn_failed" ? "error" : "info",
          text,
        });
        void this.persist();
      },
      { agentId: agent.id, replayState: false },
    );

    try {
      const prompt = this.toPrompt(loop.prompt);
      const result = await this.options.agentManager.runAgent(agent.id, prompt);
      iteration.workerCompletedAt = nowIso();
      iteration.workerOutcome = result.canceled ? "canceled" : "completed";
      if (result.canceled) {
        iteration.failureReason = "Worker run was canceled.";
        iteration.status = "stopped";
        return false;
      }
      return true;
    } catch (error) {
      iteration.workerCompletedAt = nowIso();
      iteration.workerOutcome = "failed";
      iteration.failureReason = error instanceof Error ? error.message : String(error);
      this.appendLog(loop, {
        iteration: iteration.index,
        source: "loop",
        level: "error",
        text: `Worker failed: ${iteration.failureReason}`,
      });
      return false;
    } finally {
      unsubscribe();
      loop.activeWorkerAgentId = null;
      loop.updatedAt = nowIso();
      await this.persist();
      try {
        if (loop.archive) {
          await this.options.agentManager.archiveAgent(agent.id);
        } else {
          await this.options.agentManager.closeAgent(agent.id);
        }
      } catch {
        // Ignore cleanup errors for internal loop workers.
      }
      if (signal.aborted && iteration.status === "running") {
        iteration.status = "stopped";
      }
    }
  }

  private async runVerification(
    loop: LoopRecord,
    iteration: LoopIterationRecord,
    signal: AbortSignal,
  ): Promise<boolean> {
    for (const command of loop.verifyChecks) {
      if (signal.aborted) {
        throw new Error("Loop aborted");
      }
      this.appendLog(loop, {
        iteration: iteration.index,
        source: "verify-check",
        level: "info",
        text: `$ ${command}`,
      });
      const result = await runVerifyCheck({ cwd: loop.cwd, command });
      iteration.verifyChecks.push(result);
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      this.appendLog(loop, {
        iteration: iteration.index,
        source: "verify-check",
        level: result.passed ? "info" : "error",
        text: output
          ? `exit ${result.exitCode}\n${output}`
          : `exit ${result.exitCode}`,
      });
      loop.updatedAt = nowIso();
      await this.persist();
      if (!result.passed) {
        iteration.failureReason = `Verify check failed: ${command}`;
        return false;
      }
    }

    if (!loop.verifyPrompt) {
      return true;
    }

    const startedAt = nowIso();
    const verifierAgent = await this.options.agentManager.createAgent(
      this.buildVerifierConfig(loop, iteration),
    );
    iteration.verifierAgentId = verifierAgent.id;
    loop.activeVerifierAgentId = verifierAgent.id;
    loop.updatedAt = nowIso();
    await this.persist();

    const unsubscribe = this.options.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_stream") {
          return;
        }
        const text = formatStreamLog(event.event);
        if (!text) {
          return;
        }
        this.appendLog(loop, {
          iteration: iteration.index,
          source: "verifier",
          level: event.event.type === "turn_failed" ? "error" : "info",
          text,
        });
        void this.persist();
      },
      { agentId: verifierAgent.id, replayState: false },
    );

    try {
      const result = await getStructuredAgentResponse({
        caller: async (nextPrompt) => {
          const run = await this.options.agentManager.runAgent(verifierAgent.id, this.toPrompt(nextPrompt));
          return this.resolveFinalText(run.timeline, run.finalText);
        },
        prompt: loop.verifyPrompt,
        schema: LoopVerifyPromptSchema,
        maxRetries: 2,
        schemaName: "LoopVerifierResult",
      });
      iteration.verifyPrompt = {
        passed: result.passed,
        reason: result.reason,
        verifierAgentId: verifierAgent.id,
        startedAt,
        completedAt: nowIso(),
      };
      this.appendLog(loop, {
        iteration: iteration.index,
        source: "loop",
        level: result.passed ? "info" : "error",
        text: `Verifier result: ${result.reason}`,
      });
      if (!result.passed) {
        iteration.failureReason = result.reason;
      }
      return result.passed;
    } finally {
      unsubscribe();
      loop.activeVerifierAgentId = null;
      loop.updatedAt = nowIso();
      await this.persist();
      try {
        if (loop.archive) {
          await this.options.agentManager.archiveAgent(verifierAgent.id);
        } else {
          await this.options.agentManager.closeAgent(verifierAgent.id);
        }
      } catch {
        // Ignore cleanup errors for internal loop verifiers.
      }
    }
  }

  private buildWorkerConfig(loop: LoopRecord, iteration: LoopIterationRecord): AgentSessionConfig {
    return {
      provider: loop.workerProvider ?? loop.provider,
      cwd: loop.cwd,
      model: loop.workerModel ?? loop.model ?? undefined,
      title: buildWorkerTitle(loop, iteration.index),
      internal: true,
    };
  }

  private buildVerifierConfig(loop: LoopRecord, iteration: LoopIterationRecord): AgentSessionConfig {
    return {
      provider: loop.verifierProvider ?? loop.provider,
      cwd: loop.cwd,
      model: loop.verifierModel ?? loop.model ?? undefined,
      title: buildVerifierTitle(loop, iteration.index),
      internal: true,
    };
  }

  private resolveFinalText(timeline: AgentTimelineItem[], finalText: string): string {
    if (finalText.trim()) {
      return finalText;
    }
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item?.type === "assistant_message" && item.text.trim()) {
        return item.text;
      }
    }
    return "";
  }

  private toPrompt(text: string): AgentPromptInput {
    return text;
  }

  private finishLoop(loop: LoopRecord, status: Exclude<LoopStatus, "running">, message: string): void {
    loop.status = status;
    loop.completedAt = nowIso();
    loop.updatedAt = loop.completedAt;
    loop.activeIteration = null;
    loop.activeWorkerAgentId = null;
    loop.activeVerifierAgentId = null;
    this.appendLog(loop, {
      iteration: null,
      source: "loop",
      level: status === "succeeded" ? "info" : "error",
      text: message,
    });
  }

  private appendLog(
    loop: LoopRecord,
    entry: Omit<LoopLogEntry, "seq" | "timestamp">,
  ): void {
    loop.logs.push({
      seq: loop.nextLogSeq,
      timestamp: nowIso(),
      ...entry,
    });
    loop.nextLogSeq += 1;
    loop.updatedAt = nowIso();
  }

  private requireLoop(idOrPrefix: string): LoopRecord {
    const trimmed = idOrPrefix.trim();
    if (!trimmed) {
      throw new Error("Loop id is required");
    }
    const exact = this.loops.get(trimmed);
    if (exact) {
      return exact;
    }
    const matches = Array.from(this.loops.values()).filter((record) => record.id.startsWith(trimmed));
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (matches.length > 1) {
      throw new Error(`Loop id prefix is ambiguous: ${trimmed}`);
    }
    throw new Error(`Loop not found: ${trimmed}`);
  }

  private async persist(): Promise<void> {
    const nextPersist = this.persistQueue.then(async () => {
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      const records = Array.from(this.loops.values()).sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      await fs.writeFile(this.storePath, JSON.stringify(records, null, 2), "utf8");
    });
    this.persistQueue = nextPersist.catch(() => {});
    await nextPersist;
  }
}
