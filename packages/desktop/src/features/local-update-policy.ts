export interface LocalUpdateStatus {
  active: string;
  installed: string;
  phase: "current" | "ready" | "countdown" | "activating" | "error";
  deadline?: number;
  error?: string;
}

/** A clock-driven policy; Electron owns persistence and renderer readiness. */
export class LocalUpdatePolicy {
  private lastActivity: number;
  private postponedUntil = 0;
  readonly status: LocalUpdateStatus;

  constructor(active: string, now: number) {
    this.lastActivity = now;
    this.status = { active, installed: active, phase: "current" };
  }
  installed(id: string): void {
    if (id === this.status.installed) return;
    this.status.installed = id;
    this.status.phase = id === this.status.active ? "current" : "ready";
    delete this.status.deadline;
    delete this.status.error;
  }
  activity(now: number): void {
    this.lastActivity = now;
    if (this.status.phase === "countdown" || this.status.phase === "activating") {
      this.status.phase = "ready";
      delete this.status.deadline;
    }
  }
  postpone(now: number): void {
    this.activity(now);
    this.postponedUntil = now + 30 * 60_000;
  }
  fail(error: string): void {
    this.status.phase = "error";
    this.status.error = error;
    delete this.status.deadline;
  }
  tick(now: number): LocalUpdateStatus {
    if (
      this.status.phase === "ready" &&
      now >= this.postponedUntil &&
      now - this.lastActivity >= 60_000
    ) {
      this.status.phase = "countdown";
      this.status.deadline = now + 10_000;
    } else if (this.status.phase === "countdown" && now >= this.status.deadline!) {
      this.status.phase = "activating";
    }
    return { ...this.status };
  }
}
