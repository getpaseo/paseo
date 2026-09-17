import type { CodeLocation, CodePosition, CodeQuery } from "@getpaseo/protocol/code-language";
import type { WorkspaceLanguage } from "./model";

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
  | { kind: "hover"; text: string; anchor: CodeAnchor; stale: boolean }
  | {
      kind: "popup";
      operation: CodeQuery["operation"];
      status: "loading" | "ready" | "error" | "stale";
      locations: CodeLocation[];
    };

export class LanguageActions {
  private state: LanguagePresentation = { kind: "closed" };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: AbortController | null = null;
  private last: { target: CodeTarget; operation: CodeQuery["operation"] } | null = null;
  private restoreFocus: (() => void) | null = null;
  constructor(
    readonly scope: WorkspaceLanguage,
    private readonly navigate: (location: CodeLocation) => void,
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): LanguagePresentation => this.state;
  private publish(state: LanguagePresentation): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending?.abort();
    this.pending = null;
  }
  dismiss = (): void => {
    this.cancel();
    this.publish({ kind: "closed" });
  };
  dismissHover = (): void => {
    if (this.state.kind !== "popup") this.dismiss();
  };
  close = (): void => {
    this.dismiss();
    this.restoreFocus?.();
  };
  hover(target: CodeTarget, anchor: CodeAnchor): void {
    if (this.state.kind === "popup") return;
    this.dismiss();
    this.timer = setTimeout(() => {
      void this.run(target, "hover", anchor);
    }, 300);
  }
  async run(
    target: CodeTarget,
    operation: CodeQuery["operation"],
    anchor?: CodeAnchor,
    restoreFocus?: () => void,
  ): Promise<void> {
    this.cancel();
    this.last = { target, operation };
    if (restoreFocus) this.restoreFocus = restoreFocus;
    const pending = new AbortController();
    this.pending = pending;
    const popup = operation !== "hover";
    if (popup) this.publish({ kind: "popup", operation, status: "loading", locations: [] });
    try {
      const result = await this.scope.query({ ...target, operation }, pending.signal);
      if (pending.signal.aborted) return;
      if (result.kind === "hover") {
        if (result.text)
          this.publish({
            kind: "hover",
            text: result.text,
            stale: false,
            anchor: anchor ?? { x: 100, y: 100 },
          });
        else this.dismiss();
      } else if (result.kind === "locations") {
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
      } else if (!popup && result.kind === "stale" && target.targetContentId) {
        this.publish({
          kind: "hover",
          text: "",
          stale: true,
          anchor: anchor ?? { x: 100, y: 100 },
        });
      } else if (popup || result.kind === "error") {
        this.publish({ kind: "popup", operation, status: result.kind, locations: [] });
      }
    } catch {
      if (!pending.signal.aborted)
        this.publish({ kind: "popup", operation, status: "error", locations: [] });
    }
  }
  retry = (): void => {
    if (this.last) void this.run(this.last.target, this.last.operation);
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
