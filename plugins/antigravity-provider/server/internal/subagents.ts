import { stat } from "node:fs/promises";
import path from "node:path";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { resolveConversationTranscriptPath } from "./data-dir.js";
import {
  extractBackgroundTaskKill,
  extractBackgroundTaskLaunch,
  extractSubagentControlAction,
  extractSubagentLaunchInfo,
  mapAcpToolCall,
  type SubagentControlAction,
  type SubagentLaunchInfo,
} from "./timeline.js";
import {
  cleanUserInputText,
  extractTranscriptToolResultOutput,
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
  activeTasks: Map<string, { persistent: boolean }>;
  sawAnyTranscriptStep: boolean;
  polling: boolean;
}

export class SubagentManager {
  private readonly children = new Map<string, ChildSubagentState>();
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
        sawAnyTranscriptStep: false,
        polling: false,
      };
      this.children.set(info.childSessionId, child);
    } else {
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
      if (!this.deferOpens) {
        this.ensureOpenedAndRunning(child);
        this.ensurePollLoop();
        void this.pollChild(child, false);
      }
      return;
    }

    if (action.kind === "kill_all") {
      for (const child of this.children.values()) {
        this.settleChild(child, "canceled");
      }
      return;
    }

    if (action.kind === "kill") {
      for (const id of action.conversationIds) {
        const child = this.children.get(id);
        if (child) this.settleChild(child, "canceled");
      }
    }
  }

  async flushDeferredOpens(replayAtRest = false): Promise<void> {
    this.deferOpens = false;
    for (const child of this.children.values()) {
      this.ensureOpened(child);
      await this.pollChild(child, replayAtRest);
      if (replayAtRest && child.status === "running" && !child.sawAnyTranscriptStep) {
        if (!(await pathExists(child.brainDir))) {
          this.settleChild(child, "completed");
        }
      }
    }
    if (this.hasRunning()) {
      this.ensurePollLoop();
    }
  }

  async replayFromRootTranscript(rootTranscriptPath: string): Promise<void> {
    const reader = new JsonlTranscriptReader(rootTranscriptPath);
    const steps = await reader.readNewSteps({ allowTrailingWithoutNewline: true });
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
    if (this.closed || child.polling || !child.opened) return;
    child.polling = true;
    try {
      const steps = await child.reader.readNewSteps({ allowTrailingWithoutNewline });
      for (const step of steps) {
        if (child.seenSteps.has(step.stepIndex)) continue;
        child.seenSteps.add(step.stepIndex);
        child.sawAnyTranscriptStep = true;
        this.applyChildStep(child, step);
      }
    } finally {
      child.polling = false;
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
      if (task && !task.persistent) child.activeTasks.delete(taskId);
    } else if (wakeup.sender) {
      this.applyChildWakeupSender(child, step, wakeup.sender, wakeup.message);
    }
    if (wakeup.sender && this.children.has(wakeup.sender)) {
      const nested = this.children.get(wakeup.sender)!;
      void this.settleNestedAfterWakeup(nested);
    }
    this.ensureOpenedAndRunning(child);
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

    if (step.status === "CANCELED" || step.status === "CANCELLED") {
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
    const bgLaunch = extractBackgroundTaskLaunch(updatedPayload);
    if (bgLaunch) {
      child.activeTasks.set(bgLaunch.taskId, { persistent: bgLaunch.persistent });
    }
    const killedTask = extractBackgroundTaskKill(updatedPayload);
    if (killedTask) {
      child.activeTasks.delete(killedTask);
    }
  }

  private discoverSubagentsInSteps(parentSessionId: string, steps: TranscriptStep[]): void {
    const pending: AcpToolCallPayload[] = [];
    for (const step of steps) {
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
