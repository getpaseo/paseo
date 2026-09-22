import type { CodeLocation, CodePosition, CodeQuery } from "@getpaseo/protocol/code-language";
import type { WorkspaceLanguage } from "./model";
import type { WorkspaceFileLocation } from "@/workspace/file-open";

export interface LanguageActionScope {
  serverId: string;
  cwd: string;
  onOpenLocation(location: WorkspaceFileLocation): void;
}

export interface CodeTarget {
  path: string;
  position: CodePosition;
  targetContentId?: string;
}
export interface CodeAnchor {
  x: number;
  y: number;
}
export type LanguagePresentation =
  | { kind: "closed" }
  | {
      kind: "hover";
      text: string;
      anchor: CodeAnchor;
      stale: boolean;
      error: boolean;
      interactive: boolean;
    }
  | {
      kind: "popup";
      operation: Exclude<CodeQuery["operation"], "hover">;
      status: "loading" | "ready" | "error" | "stale";
      locations: CodeLocation[];
    };

export interface LanguageActionClock {
  schedule(callback: () => void | Promise<void>, delayMs: number): () => void;
}
const DEFAULT_CLOCK: LanguageActionClock = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
function sameTarget(left: CodeTarget | null, right: CodeTarget): boolean {
  return (
    left?.path === right.path &&
    left.targetContentId === right.targetContentId &&
    left.position.line === right.position.line &&
    left.position.character === right.position.character
  );
}

export class LanguageActions {
  private state: LanguagePresentation = { kind: "closed" };
  private listeners = new Set<() => void>();
  private cancelTimer: (() => void) | null = null;
  private pending: AbortController | null = null;
  private hoverTarget: CodeTarget | null = null;
  private last: {
    target: CodeTarget;
    operation: CodeQuery["operation"];
    anchor?: CodeAnchor;
    interactive: boolean;
  } | null = null;
  private restoreFocus: (() => void) | null = null;
  constructor(
    readonly scope: WorkspaceLanguage,
    private readonly navigate: (location: CodeLocation) => void,
    private readonly clock: LanguageActionClock = DEFAULT_CLOCK,
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): LanguagePresentation => this.state;
  private publish(state: LanguagePresentation): void {
    if (state.kind === "closed" && this.state.kind === "closed") return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private showHover(
    status: "ready" | "stale" | "error",
    anchor: CodeAnchor | undefined,
    interactive: boolean,
    text = "",
  ): void {
    this.publish({
      kind: "hover",
      text,
      stale: status === "stale",
      error: status === "error",
      interactive,
      anchor: anchor ?? { x: 100, y: 100 },
    });
  }
  private cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.pending?.abort();
    this.pending = null;
  }
  dismiss = (): void => {
    this.cancel();
    this.hoverTarget = null;
    this.publish({ kind: "closed" });
  };
  dismissHover = (): void => {
    if (this.state.kind !== "popup") this.dismiss();
  };
  holdHover = (): void => {
    if (this.state.kind !== "hover") return;
    this.cancel();
    this.hoverTarget = this.last?.target ?? null;
  };
  leaveHover = (): void => {
    if (this.state.kind === "popup" || (this.state.kind === "hover" && this.state.interactive))
      return;
    this.cancel();
    this.hoverTarget = null;
    this.cancelTimer = this.clock.schedule(this.dismissHover, 150);
  };
  close = (): void => {
    const restoreFocus = this.restoreFocus;
    this.restoreFocus = null;
    this.dismiss();
    restoreFocus?.();
  };
  hover(target: CodeTarget, anchor: CodeAnchor): void {
    if (this.state.kind === "popup" || (this.state.kind === "hover" && this.state.interactive))
      return;
    if (sameTarget(this.hoverTarget, target)) return;
    this.cancel();
    this.hoverTarget = target;
    this.restoreFocus = null;
    // Keep the current card reachable while the pointer travels through the source.
    this.cancelTimer = this.clock.schedule(() => this.execute(target, "hover", anchor, false), 300);
  }
  run(
    target: CodeTarget,
    operation: CodeQuery["operation"],
    anchor?: CodeAnchor,
    restoreFocus?: () => void,
  ): Promise<void> {
    this.restoreFocus = restoreFocus ?? null;
    return this.execute(target, operation, anchor, true);
  }
  private async execute(
    target: CodeTarget,
    operation: CodeQuery["operation"],
    anchor: CodeAnchor | undefined,
    interactive: boolean,
  ): Promise<void> {
    this.cancel();
    this.last = { target, operation, anchor, interactive };
    const pending = new AbortController();
    this.pending = pending;
    if (operation !== "hover")
      this.publish({ kind: "popup", operation, status: "loading", locations: [] });
    else this.publish({ kind: "closed" });
    try {
      const result = await this.scope.query({ ...target, operation }, pending.signal);
      if (pending.signal.aborted) return;
      if (operation === "hover") {
        if (result.kind === "hover" && result.text) {
          this.showHover("ready", anchor, interactive, result.text);
        } else if (result.kind === "stale" && (target.targetContentId || interactive)) {
          this.showHover("stale", anchor, interactive);
        } else if (result.kind === "error" && interactive) {
          this.showHover("error", anchor, interactive);
        } else this.dismiss();
        return;
      }
      if (result.kind === "locations") {
        const unique = new Map(
          result.locations.map((location) => [JSON.stringify(location), location]),
        );
        const locations = [...unique.values()].sort(
          (a, b) =>
            a.path.localeCompare(b.path) ||
            a.range.start.line - b.range.start.line ||
            a.range.start.character - b.range.start.character,
        );
        if (operation === "definition" && locations.length === 1) this.select(locations[0]!);
        else this.publish({ kind: "popup", operation, status: "ready", locations });
      } else {
        this.publish({
          kind: "popup",
          operation,
          status: result.kind === "stale" ? "stale" : "error",
          locations: [],
        });
      }
    } catch {
      if (pending.signal.aborted) return;
      if (operation !== "hover")
        this.publish({ kind: "popup", operation, status: "error", locations: [] });
      else if (interactive) this.showHover("error", anchor, interactive);
      else this.dismiss();
    }
  }
  retry = async (): Promise<void> => {
    if (this.last)
      await this.execute(
        this.last.target,
        this.last.operation,
        this.last.anchor,
        this.last.interactive,
      );
  };
  select = (location: CodeLocation): void => {
    this.dismiss();
    this.navigate(location);
  };
  openCurrent = (): void => {
    if (!this.last) return;
    const { path, position } = this.last.target;
    this.select({ path, range: { start: position, end: position } });
  };
}
