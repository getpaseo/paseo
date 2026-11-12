import { stat } from "node:fs/promises";
import path from "node:path";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { resolveConversationTranscriptPath } from "./data-dir.js";
import {
  extractBackgroundTaskKill,
  extractBackgroundTaskLaunch,
  extractSubagentControlAction,
  extractSubagentLaunchInfo,
  extractSubagentListSnapshot,
  mapAcpToolCall,
  type SubagentControlAction,
  type SubagentLaunchInfo,
  type SubagentListEntry,
} from "./timeline.js";
import {
  cleanUserInputText,
  extractTranscriptToolResultOutput,
  isNonTerminalStepStatus,
  isWaitingStepStatus,
  JsonlTranscriptReader,
  parseSystemWakeupMessage,
  type SystemWakeupInfo,
  type TranscriptStep,
} from "./transcript.js";
import type { AcpToolCallPayload } from "./wire.js";

const POLL_INTERVAL_MS = 180;

interface PendingChildToolCall {
  payload: AcpToolCallPayload;
}

interface ChildSubagentState {
  id: string;
  parentSessionId: string;
  toolCallId?: string;
  title?: string;
  description?: string;
  cwd: string;
  brainDir: string;
  reader: JsonlTranscriptReader;
  opened: boolean;
  status: "running" | "completed" | "failed" | "canceled";
  activeTurnId: string | null;
  turnSeq: number;
  seenSteps: Set<number>;
  pendingToolCalls: PendingChildToolCall[];
  activeTasks: Map<string, { persistent: boolean; prompt?: string }>;
  forcedTerminalState: "canceled" | "failed" | null;
  settledByListSnapshot: boolean;
  sawAnyTranscriptStep: boolean;
  pollPromise: Promise<void> | null;
}

export class SubagentManager {
  private readonly children = new Map<string, ChildSubagentState>();
  private readonly pendingReconciles = new Set<Promise<void>>();
  private deferOpens = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly rootSessionId: string,
    private readonly defaultCwd: string,
    private dataDir: string,
    private readonly emit: (event: ProviderEvent) => void,
  ) {}

  setDataDir(dataDir: string): void {
    this.dataDir = dataDir;
  }

  setDeferOpens(defer: boolean): void {
    this.deferOpens = defer;
  }

  hasRunning(): boolean {
    for (const child of this.children.values()) {
      if (child.status === "running") return true;
    }
    return false;
  }

  hasChild(sessionId: string): boolean {
    return this.children.has(sessionId);
  }

  registerLaunch(parentSessionId: string, info: SubagentLaunchInfo): void {
    if (this.closed) return;
    let child = this.children.get(info.childSessionId);
    if (!child) {
      const transcriptPath =
        info.logPath && info.logPath.endsWith(".jsonl")
          ? info.logPath
          : resolveConversationTranscriptPath(this.dataDir, info.childSessionId);
      child = {
        id: info.childSessionId,
        parentSessionId,
        ...(info.toolCallId ? { toolCallId: info.toolCallId } : {}),
        ...(info.title ? { title: info.title } : {}),
        ...(info.description ? { description: info.description } : {}),
        cwd: info.cwd || this.defaultCwd,
        brainDir: path.join(this.dataDir, "brain", info.childSessionId),
        reader: new JsonlTranscriptReader(transcriptPath),
        opened: false,
        status: "running",
        activeTurnId: null,
        turnSeq: 0,
        seenSteps: new Set(),
        pendingToolCalls: [],
        activeTasks: new Map(),
        forcedTerminalState: null,
        settledByListSnapshot: false,
        sawAnyTranscriptStep: false,
        pollPromise: null,
      };
      this.children.set(info.childSessionId, child);
    } else {
      child.forcedTerminalState = null;
      child.settledByListSnapshot = false;
      if (!child.title && info.title) child.title = info.title;
      if (!child.description && info.description) child.description = info.description;
      if (!child.toolCallId && info.toolCallId) child.toolCallId = info.toolCallId;
    }

    if (!this.deferOpens) {
      this.ensureOpenedAndRunning(child);
      this.ensurePollLoop();
      void this.pollChild(child, false);
    }
  }

  applyControlAction(action: SubagentControlAction): void {
    if (this.closed) return;
    if (action.kind === "send_message") {
      const child = this.children.get(action.recipientId);
      if (!child) return;
      child.forcedTerminalState = null;
      child.settledByListSnapshot = false;
      if (!this.deferOpens) {
        this.ensureOpenedAndRunning(child);
        this.ensurePollLoop();
        void this.pollChild(child, false);
      }
      return;
    }

    if (action.kind === "kill_all") {
      for (const child of this.children.values()) {
        this.markSubtreeCanceled(child);
      }
      return;
    }

    if (action.kind === "kill") {
      for (const id of action.conversationIds) {
        const child = this.children.get(id);
        if (child) this.markSubtreeCanceled(child);
      }
    }
  }

  reconcileActiveList(entries: readonly SubagentListEntry[]): Promise<void> {
    if (this.closed) return Promise.resolve();
    const runningIds = new Set(
      entries.filter((entry) => entry.state === "running").map((entry) => entry.conversationId),
    );
    if (this.deferOpens) {
      for (const child of this.children.values()) {
        if (!runningIds.has(child.id)) {
          child.settledByListSnapshot = true;
        }
      }
      return Promise.resolve();
    }

    const task = (async () => {
      for (const child of this.children.values()) {
        if (child.status !== "running" || runningIds.has(child.id)) continue;
        child.settledByListSnapshot = true;
        await this.pollChild(child, true);
        if (child.status !== "running" && child.forcedTerminalState !== null) continue;
        if (child.activeTurnId === null && child.status !== "running") continue;
        const finalState = child.forcedTerminalState ?? "completed";
        this.settlePendingChildTools(child, finalState === "completed" ? "completed" : "failed");
        child.activeTasks.clear();
        this.settleChild(child, finalState);
      }
    })();
    this.pendingReconciles.add(task);
    void task.finally(() => {
      this.pendingReconciles.delete(task);
    });
    return task;
  }

  settleAllRunning(state: "canceled" | "failed"): void {
    if (this.closed) return;
    for (const child of this.children.values()) {
      if (child.status !== "running") continue;
      child.forcedTerminalState = state;
      this.settlePendingChildTools(child, "failed");
      child.activeTasks.clear();
      this.settleChild(child, state);
    }
  }

  async flushDeferredOpens(replayAtRest = false): Promise<void> {
    try {
      for (const child of this.children.values()) {
        const parent = this.children.get(child.parentSessionId);
        if (parent?.forcedTerminalState === "canceled") {
          child.forcedTerminalState = "canceled";
        }
        this.ensureOpened(child);
        await this.pollChild(child, replayAtRest);
        this.finalizeReplayedChild(child, replayAtRest);
      }
    } finally {
      this.deferOpens = false;
    }
    if (this.hasRunning()) {
      this.ensurePollLoop();
    }
  }

  async replayFromRootTranscript(rootTranscriptPath: string): Promise<void> {
    const reader = new JsonlTranscriptReader(rootTranscriptPath);
    const steps = await reader.readNewSteps({
      allowTrailingWithoutNewline: true,
      advancePastUnfinished: true,
    });
    this.discoverSubagentsInSteps(this.rootSessionId, steps);
    await this.flushDeferredOpens(true);
  }

  async handleParentWakeupSender(sender: string | undefined): Promise<void> {
    if (!sender) return;
    const child = this.children.get(sender);
    if (!child) return;
    await this.pollChild(child, true);
    if (
      child.status === "running" &&
      child.activeTasks.size === 0 &&
      child.pendingToolCalls.length === 0
    ) {
      this.settleChild(child, "completed");
    }
  }

  async settleSyntheticChildrenAfterForegroundTurn(): Promise<void> {
    if (this.pendingReconciles.size > 0) {
      await Promise.allSettled(this.pendingReconciles);
    }
    for (const child of this.children.values()) {
      if (child.status !== "running") continue;
      await this.pollChild(child, false);
      if (child.status !== "running") continue;
      if (!child.sawAnyTranscriptStep && !(await pathExists(child.brainDir))) {
        this.settleChild(child, "completed");
      }
    }
    this.stopPollLoopIfIdle();
  }

  async pollAll(allowTrailingWithoutNewline = false): Promise<void> {
    await Promise.all(
      [...this.children.values()].map((child) =>
        this.pollChild(child, allowTrailingWithoutNewline),
      ),
    );
    this.stopPollLoopIfIdle();
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const child of this.children.values()) {
      if (child.opened) {
        this.emit({
          type: "session.closed",
          sessionId: child.id,
          ...(child.status === "failed"
            ? { error: { message: "Subagent failed", code: "PROCESS_FAILED" } }
            : {}),
        });
      }
    }
    this.children.clear();
  }

  private markSubtreeCanceled(target: ChildSubagentState): void {
    target.forcedTerminalState = "canceled";
    if (!this.deferOpens) {
      this.settlePendingChildTools(target, "failed");
      target.activeTasks.clear();
      this.settleChild(target, "canceled");
    }
    for (const descendant of this.children.values()) {
      if (descendant.parentSessionId === target.id && descendant !== target) {
        this.markSubtreeCanceled(descendant);
      }
    }
  }

  private finalizeReplayedChild(child: ChildSubagentState, replayAtRest: boolean): void {
    if (child.forcedTerminalState !== null) {
      this.settlePendingChildTools(child, "failed");
      child.activeTasks.clear();
      this.settleChild(child, child.forcedTerminalState);
      return;
    }
    if (child.settledByListSnapshot && child.status === "running") {
      this.settlePendingChildTools(child, "completed");
      child.activeTasks.clear();
      this.settleChild(child, "completed");
      return;
    }
    if (replayAtRest && child.status === "running") {
      // A fresh agy ACP process has no live in-memory subagents from prior runs.
      const finalState = child.sawAnyTranscriptStep ? "canceled" : "completed";
      this.settlePendingChildTools(child, finalState === "canceled" ? "failed" : "completed");
      child.activeTasks.clear();
      this.settleChild(child, finalState);
    }
  }

  private settlePendingChildTools(
    child: ChildSubagentState,
    terminalStatus: "completed" | "failed",
  ): void {
    for (const pending of child.pendingToolCalls.splice(0)) {
      const settledPayload: AcpToolCallPayload = {
        ...pending.payload,
        status: terminalStatus,
      };
      if (child.opened && !this.closed) {
        this.emit({
          type: "timeline.item",
          sessionId: child.id,
          item: mapAcpToolCall(settledPayload),
        });
      }
    }
  }

  private ensureOpened(child: ChildSubagentState): void {
    if (child.opened || this.closed) return;
    child.opened = true;
    this.emit({
      type: "session.opened",
      sessionId: child.id,
      parentSessionId: child.parentSessionId,
      ...(child.toolCallId ? { toolCallId: child.toolCallId } : {}),
      capabilities: [],
      restoration: "parent",
      ...(child.title ? { title: child.title } : {}),
      ...(child.description ? { description: child.description } : {}),
      cwd: child.cwd,
    });
  }

  private ensureOpenedAndRunning(child: ChildSubagentState): void {
    this.ensureOpened(child);
    if (!this.deferOpens && child.forcedTerminalState !== null) {
      return;
    }
    if (child.activeTurnId === null && !this.closed) {
      const turnId = `subturn-${++child.turnSeq}`;
      child.activeTurnId = turnId;
      child.status = "running";
      this.emit({
        type: "session.turn",
        sessionId: child.id,
        turnId,
        state: "started",
      });
    }
  }

  private settleChild(child: ChildSubagentState, state: "completed" | "failed" | "canceled"): void {
    if (this.closed) return;
    this.ensureOpened(child);
    if (child.status === state && child.activeTurnId === null) return;
    const turnId = child.activeTurnId ?? `subturn-${++child.turnSeq}`;
    if (child.activeTurnId === null) {
      this.emit({
        type: "session.turn",
        sessionId: child.id,
        turnId,
        state: "started",
      });
    }
    child.activeTurnId = null;
    child.status = state;
    this.emit({
      type: "session.turn",
      sessionId: child.id,
      turnId,
      state,
    });
    this.stopPollLoopIfIdle();
  }

  private async pollChild(
    child: ChildSubagentState,
    allowTrailingWithoutNewline: boolean,
  ): Promise<void> {
    if (this.closed || !child.opened) return;
    if (child.pollPromise) {
      await child.pollPromise;
      if (!allowTrailingWithoutNewline || this.closed || !child.opened) return;
    }
    const run = (async () => {
      const steps = await child.reader.readNewSteps({ allowTrailingWithoutNewline });
      for (const step of steps) {
        if (child.seenSteps.has(step.stepIndex)) continue;
        child.sawAnyTranscriptStep = true;
        if (shouldDeferChildTranscriptStep(step)) continue;
        child.seenSteps.add(step.stepIndex);
        this.applyChildStep(child, step);
      }
    })();
    child.pollPromise = run;
    try {
      await run;
    } finally {
      if (child.pollPromise === run) {
        child.pollPromise = null;
      }
    }
  }

  private applyChildStep(child: ChildSubagentState, step: TranscriptStep): void {
    if (step.type === "USER_INPUT") {
      this.applyChildUserStep(child, step);
      return;
    }
    const wakeup = parseSystemWakeupMessage(step);
    if (wakeup) {
      this.applyChildWakeupStep(child, step, wakeup);
      return;
    }
    if (step.type === "PLANNER_RESPONSE") {
      this.applyChildPlannerStep(child, step);
      return;
    }
    if (step.type === "GENERIC" && child.pendingToolCalls.length > 0) {
      this.applyChildGenericStep(child, step);
    }
  }

  private applyChildUserStep(child: ChildSubagentState, step: TranscriptStep): void {
    this.ensureOpenedAndRunning(child);
    const text = cleanUserInputText(step.content);
    if (!text) return;
    this.emit({
      type: "timeline.item",
      sessionId: child.id,
      item: {
        type: "user_message",
        id: `sub-user-${step.stepIndex}`,
        text,
      },
      ...(step.createdAt ? { timestamp: step.createdAt } : {}),
    });
  }

  private applyChildWakeupStep(
    child: ChildSubagentState,
    step: TranscriptStep,
    wakeup: SystemWakeupInfo,
  ): void {
    if (wakeup.finishedTaskId || wakeup.failedTaskId) {
      const taskId = wakeup.finishedTaskId ?? wakeup.failedTaskId!;
      const task = child.activeTasks.get(taskId);
      if (task && (!task.persistent || Boolean(wakeup.failedTaskId))) {
        child.activeTasks.delete(taskId);
      }
    } else if (wakeup.sender) {
      this.applyChildWakeupSender(child, step, wakeup.sender, wakeup.message);
    }
    this.clearChildScheduleWakeupTask(child, wakeup);
    if (wakeup.sender && this.children.has(wakeup.sender)) {
      const nested = this.children.get(wakeup.sender)!;
      void this.settleNestedAfterWakeup(nested);
    }
    this.ensureOpenedAndRunning(child);
  }

  private clearChildScheduleWakeupTask(child: ChildSubagentState, wakeup: SystemWakeupInfo): void {
    const isScheduleWakeup =
      wakeup.sender === "scheduler" ||
      Boolean(wakeup.sender?.includes("schedule")) ||
      (!wakeup.finishedTaskId && !wakeup.failedTaskId && !wakeup.sender);
    if (!isScheduleWakeup) return;
    let fallbackTaskId: string | null = null;
    for (const [taskId, entry] of child.activeTasks) {
      if (!taskId.startsWith("schedule:") || entry.persistent) continue;
      if (entry.prompt && wakeup.message.includes(entry.prompt)) {
        child.activeTasks.delete(taskId);
        return;
      }
      fallbackTaskId ??= taskId;
    }
    if (fallbackTaskId) {
      child.activeTasks.delete(fallbackTaskId);
    }
  }

  private applyChildWakeupSender(
    child: ChildSubagentState,
    step: TranscriptStep,
    sender: string,
    message: string,
  ): void {
    const task = child.activeTasks.get(sender);
    if (task && !task.persistent) {
      child.activeTasks.delete(sender);
      return;
    }
    if (!this.children.has(sender) && message) {
      this.ensureOpenedAndRunning(child);
      this.emit({
        type: "timeline.item",
        sessionId: child.id,
        item: {
          type: "user_message",
          id: `sub-msg-in-${step.stepIndex}`,
          text: message,
        },
        ...(step.createdAt ? { timestamp: step.createdAt } : {}),
      });
    }
  }

  private async settleNestedAfterWakeup(nested: ChildSubagentState): Promise<void> {
    await this.pollChild(nested, true);
    if (
      nested.status === "running" &&
      nested.activeTasks.size === 0 &&
      nested.pendingToolCalls.length === 0
    ) {
      this.settleChild(nested, "completed");
    }
  }

  private applyChildPlannerStep(child: ChildSubagentState, step: TranscriptStep): void {
    this.ensureOpenedAndRunning(child);
    this.emitChildPlannerText(child, step);

    if (step.toolCalls.length > 0) {
      this.enqueueChildToolCalls(child, step);
      return;
    }

    if (step.status === "ERROR") {
      this.emit({
        type: "timeline.item",
        sessionId: child.id,
        item: {
          type: "error",
          id: `sub-err-${step.stepIndex}`,
          message: step.error || "Subagent execution failed",
        },
        ...(step.createdAt ? { timestamp: step.createdAt } : {}),
      });
      this.settleChild(child, "failed");
      return;
    }

    if (
      step.status === "CANCELED" ||
      step.status === "CANCELLED" ||
      step.status === "INTERRUPTED"
    ) {
      this.settleChild(child, "canceled");
      return;
    }

    if (child.activeTasks.size === 0 && child.pendingToolCalls.length === 0) {
      this.settleChild(child, "completed");
    }
  }

  private emitChildPlannerText(child: ChildSubagentState, step: TranscriptStep): void {
    if (step.thinking?.trim()) {
      this.emit({
        type: "timeline.item",
        sessionId: child.id,
        item: {
          type: "reasoning",
          id: `sub-thought-${step.stepIndex}`,
          text: step.thinking,
        },
        ...(step.createdAt ? { timestamp: step.createdAt } : {}),
      });
    }
    if (step.content?.trim()) {
      this.emit({
        type: "timeline.item",
        sessionId: child.id,
        item: {
          type: "assistant_message",
          id: `sub-assistant-${step.stepIndex}`,
          text: step.content,
        },
        ...(step.createdAt ? { timestamp: step.createdAt } : {}),
      });
    }
  }

  private enqueueChildToolCalls(child: ChildSubagentState, step: TranscriptStep): void {
    step.toolCalls.forEach((call, index) => {
      const toolCallId = call.id ?? `sub-tool-${step.stepIndex}-${index}`;
      const payload: AcpToolCallPayload = {
        toolCallId,
        title: call.name,
        status: "in_progress",
        rawInput: call.args,
      };
      child.pendingToolCalls.push({ payload });
      this.emit({
        type: "timeline.item",
        sessionId: child.id,
        item: mapAcpToolCall(payload),
        ...(step.createdAt ? { timestamp: step.createdAt } : {}),
      });
      const action = extractSubagentControlAction(payload);
      if (action) this.applyControlAction(action);
    });
  }

  private applyChildGenericStep(child: ChildSubagentState, step: TranscriptStep): void {
    const next = child.pendingToolCalls.shift()!;
    const output = extractTranscriptToolResultOutput(step);
    const isFailed = step.status === "ERROR";
    const updatedPayload: AcpToolCallPayload = {
      ...next.payload,
      status: isFailed ? "failed" : "completed",
      ...(output !== undefined ? { rawOutput: isFailed ? { error: output } : { output } } : {}),
    };
    this.emit({
      type: "timeline.item",
      sessionId: child.id,
      item: mapAcpToolCall(updatedPayload),
      ...(step.createdAt ? { timestamp: step.createdAt } : {}),
    });

    const nestedLaunch = extractSubagentLaunchInfo(updatedPayload, child.cwd);
    if (nestedLaunch) {
      this.registerLaunch(child.id, nestedLaunch);
    }
    const listSnapshot = extractSubagentListSnapshot(updatedPayload);
    if (listSnapshot) {
      void this.reconcileActiveList(listSnapshot);
    }
    const bgLaunch = extractBackgroundTaskLaunch(updatedPayload);
    if (bgLaunch) {
      child.activeTasks.set(bgLaunch.taskId, {
        persistent: bgLaunch.persistent,
        ...(bgLaunch.prompt ? { prompt: bgLaunch.prompt } : {}),
      });
    }
    const killedTask = extractBackgroundTaskKill(updatedPayload);
    if (killedTask) {
      child.activeTasks.delete(killedTask);
    }
  }

  private discoverSubagentsInSteps(parentSessionId: string, steps: TranscriptStep[]): void {
    const pending: AcpToolCallPayload[] = [];
    for (const step of steps) {
      if (shouldDeferChildTranscriptStep(step)) continue;
      if (step.type === "PLANNER_RESPONSE" && step.toolCalls.length > 0) {
        step.toolCalls.forEach((call, index) => {
          const payload: AcpToolCallPayload = {
            toolCallId: call.id ?? `replay-tool-${step.stepIndex}-${index}`,
            title: call.name,
            status: "in_progress",
            rawInput: call.args,
          };
          pending.push(payload);
          const control = extractSubagentControlAction(payload);
          if (control) this.applyControlAction(control);
        });
      } else if (step.type === "GENERIC" && pending.length > 0) {
        const prev = pending.shift()!;
        const output = extractTranscriptToolResultOutput(step);
        const completed: AcpToolCallPayload = {
          ...prev,
          status: step.status === "ERROR" ? "failed" : "completed",
          ...(output !== undefined ? { rawOutput: { output } } : {}),
        };
        const launch = extractSubagentLaunchInfo(completed, this.defaultCwd);
        if (launch) {
          this.registerLaunch(parentSessionId, launch);
        }
        const listSnapshot = extractSubagentListSnapshot(completed);
        if (listSnapshot) {
          void this.reconcileActiveList(listSnapshot);
        }
      }
    }
  }

  private ensurePollLoop(): void {
    if (this.pollTimer || this.closed) return;
    this.pollTimer = setInterval(() => {
      void this.pollAll(false);
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private stopPollLoopIfIdle(): void {
    if (!this.hasRunning() && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

function shouldDeferChildTranscriptStep(step: TranscriptStep): boolean {
  if (step.type === "PLANNER_RESPONSE" && isNonTerminalStepStatus(step.status)) {
    return true;
  }
  if (step.type === "GENERIC" && isWaitingStepStatus(step.status)) {
    return true;
  }
  return false;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
