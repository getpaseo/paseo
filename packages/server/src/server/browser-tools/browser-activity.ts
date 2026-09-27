import { randomUUID } from "node:crypto";
import type {
  BrowserActivityControlRequest,
  BrowserActivityEvent,
  BrowserActivityPhase,
  BrowserActivityStep,
  BrowserHandoff,
} from "@getpaseo/protocol/browser-activity/rpc-schemas";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { getBrowserIdForCommand } from "./broker.js";
import { browserToolsFailure, type BrowserToolsResponsePayload } from "./errors.js";

export interface BrowserActivityPatch {
  phase: BrowserActivityPhase;
  step?: number;
  /** `null` clears the field; `undefined` keeps it. */
  action?: BrowserActivityStep | null;
  next?: BrowserActivityStep | null;
  steps?: BrowserActivityStep[];
}

export interface BrowserActivityReporter {
  update(patch: BrowserActivityPatch): void;
  /**
   * A safe boundary between browser actions. Resolves at once unless the user took over;
   * resolves `true` after a takeover ends so the runner observes the page again first.
   */
  checkpoint(): Promise<boolean>;
}

export interface BrowserActivityRun extends BrowserActivityReporter {
  finish(result: NonNullable<BrowserActivityEvent["result"]>): void;
}

export const NOOP_BROWSER_ACTIVITY: BrowserActivityRun = {
  update: () => {},
  checkpoint: async () => false,
  finish: () => {},
};

interface ActiveRun {
  event: BrowserActivityEvent;
  resume: (() => void) | null;
}

interface ActiveHandoff {
  handoff: BrowserHandoff;
  onEnd: (handoff: BrowserHandoff) => void;
}

// Ended handoffs stay replayable so a reloaded chat still shows how each one ended.
const ENDED_HANDOFF_LIMIT = 50;

export class BrowserActivityHub {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly handoffs = new Map<string, ActiveHandoff>();
  private endedHandoffs: BrowserHandoff[] = [];

  public constructor(
    private readonly publish: (event: BrowserActivityEvent) => void,
    private readonly publishHandoff: (handoff: BrowserHandoff) => void = () => {},
  ) {}

  public start(input: {
    workspaceId: string;
    browserId: string;
    kind: BrowserActivityEvent["kind"];
    label: string;
    totalSteps?: number;
    steps?: BrowserActivityStep[];
  }): BrowserActivityRun {
    const run: ActiveRun = {
      event: {
        runId: randomUUID(),
        workspaceId: input.workspaceId,
        browserId: input.browserId,
        kind: input.kind,
        label: input.label,
        phase: "observing",
        step: 0,
        ...(input.totalSteps !== undefined ? { totalSteps: input.totalSteps } : {}),
        steps: input.steps ?? [],
        pauseRequested: false,
        updatedAt: Date.now(),
      },
      resume: null,
    };
    this.runs.set(run.event.runId, run);
    this.emit(run);
    return {
      update: (patch) => {
        if (this.runs.get(run.event.runId) === run) this.apply(run, patch);
      },
      checkpoint: () => this.checkpoint(run),
      finish: (result) => {
        if (!this.runs.delete(run.event.runId)) return;
        run.event = {
          ...patchEvent(run.event, { phase: "finished", next: null }),
          pauseRequested: false,
          result,
        };
        this.emit(run);
      },
    };
  }

  /** Hands the tab to the user; `onEnd` runs once when they finish or cancel. */
  public startHandoff(input: {
    workspaceId: string;
    browserId: string;
    agentId: string;
    reason: string;
    onEnd: (handoff: BrowserHandoff) => void;
  }): BrowserHandoff | null {
    if (this.handoffs.has(input.browserId)) return null;
    const handoff: BrowserHandoff = {
      handoffId: randomUUID(),
      workspaceId: input.workspaceId,
      browserId: input.browserId,
      agentId: input.agentId,
      reason: input.reason,
      status: "active",
      updatedAt: Date.now(),
    };
    this.handoffs.set(input.browserId, { handoff, onEnd: input.onEnd });
    this.publishHandoff(handoff);
    return handoff;
  }

  public activeHandoff(browserId: string): BrowserHandoff | null {
    return this.handoffs.get(browserId)?.handoff ?? null;
  }

  /** Active and recently ended handoffs, for subscribers that join late. */
  public currentHandoffs(): BrowserHandoff[] {
    return [...this.endedHandoffs, ...[...this.handoffs.values()].map((entry) => entry.handoff)];
  }

  /**
   * Wraps an automation path so it refuses commands on a handed-off tab. Only agent-facing
   * paths use it; the app's viewport keeps capturing frames and forwarding the user's input.
   */
  public guard<T extends { command: BrowserAutomationCommand; requestId?: string }>(
    execute: (input: T) => Promise<BrowserToolsResponsePayload>,
  ): (input: T) => Promise<BrowserToolsResponsePayload> {
    return async (input) => {
      const requestId = input.requestId ?? `browser_${randomUUID()}`;
      return this.refuseHandedOff(input.command, requestId) ?? execute({ ...input, requestId });
    };
  }

  public refuseHandedOff(
    command: BrowserAutomationCommand,
    requestId = "browser-handoff",
  ): BrowserToolsResponsePayload | null {
    const browserId = getBrowserIdForCommand(command);
    const handoff = browserId ? this.activeHandoff(browserId) : null;
    if (!handoff) return null;
    return browserToolsFailure({
      requestId,
      code: "browser_denied",
      message: `Browser tab ${handoff.browserId} is handed off to the user ("${handoff.reason}"). The user controls this tab until they finish the handoff; you will get a message when they do. Do not use browser tools on it until then.`,
    });
  }

  /** Applies to every active run on the browser, or to its handoff; returns whether one matched. */
  public control(
    input: Pick<BrowserActivityControlRequest, "workspaceId" | "browserId" | "action">,
  ): boolean {
    if (input.action === "finish_handoff" || input.action === "cancel_handoff") {
      return this.endHandoff({
        workspaceId: input.workspaceId,
        browserId: input.browserId,
        status: input.action === "finish_handoff" ? "done" : "cancelled",
      });
    }
    let applied = false;
    for (const run of this.runs.values()) {
      if (run.event.workspaceId !== input.workspaceId || run.event.browserId !== input.browserId) {
        continue;
      }
      applied = true;
      if (input.action === "pause") {
        if (!run.resume && !run.event.pauseRequested) {
          run.event = { ...run.event, pauseRequested: true };
          this.emit(run);
        }
      } else if (run.resume) {
        run.resume();
      } else if (run.event.pauseRequested) {
        run.event = { ...run.event, pauseRequested: false };
        this.emit(run);
      }
    }
    return applied;
  }

  /** Current state of every active run, for subscribers that join mid-run. */
  public current(): BrowserActivityEvent[] {
    return [...this.runs.values()].map((run) => run.event);
  }

  private endHandoff(input: {
    workspaceId: string;
    browserId: string;
    status: "done" | "cancelled";
  }): boolean {
    const active = this.handoffs.get(input.browserId);
    if (!active || active.handoff.workspaceId !== input.workspaceId) return false;
    this.handoffs.delete(input.browserId);
    const ended: BrowserHandoff = {
      ...active.handoff,
      status: input.status,
      updatedAt: Date.now(),
    };
    this.endedHandoffs = [...this.endedHandoffs, ended].slice(-ENDED_HANDOFF_LIMIT);
    this.publishHandoff(ended);
    active.onEnd(ended);
    return true;
  }

  private async checkpoint(run: ActiveRun): Promise<boolean> {
    if (!run.event.pauseRequested || this.runs.get(run.event.runId) !== run) return false;
    const resumed = new Promise<void>((resolve) => {
      run.resume = resolve;
    });
    run.event = {
      ...patchEvent(run.event, { phase: "paused", action: null }),
      pauseRequested: false,
    };
    this.emit(run);
    await resumed;
    run.resume = null;
    return true;
  }

  private apply(run: ActiveRun, patch: BrowserActivityPatch): void {
    run.event = patchEvent(run.event, patch);
    this.emit(run);
  }

  private emit(run: ActiveRun): void {
    run.event = { ...run.event, updatedAt: Date.now() };
    this.publish(run.event);
  }
}

function patchEvent(
  event: BrowserActivityEvent,
  patch: BrowserActivityPatch,
): BrowserActivityEvent {
  const { action, next, ...rest } = event;
  const nextAction = patch.action === undefined ? action : (patch.action ?? undefined);
  const nextStep = patch.next === undefined ? next : (patch.next ?? undefined);
  return {
    ...rest,
    phase: patch.phase,
    ...(patch.step !== undefined ? { step: patch.step } : {}),
    ...(patch.steps ? { steps: patch.steps } : {}),
    ...(nextAction ? { action: nextAction } : {}),
    ...(nextStep ? { next: nextStep } : {}),
  };
}
