import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/client";
import type { AgentSubsession } from "../../agent-sdk-types.js";

/** Hard cap so a runaway session tree cannot grow tracker memory unbounded. */
const MAX_TRACKED_SUBSESSIONS = 100;

export interface OpenCodeSubsessionSeed {
  id: string;
  title: string | null;
  parentSessionId: string | null;
}

/**
 * Tracks an agent's native OpenCode subsessions (child sessions) from the
 * `/global/event` stream. A subsession is just a session whose `parentID`
 * chain reaches the agent's root session: it has its own live status and
 * stays tracked until the provider deletes it.
 *
 * Deliberately separate from the per-turn translation state: subsession
 * activity keeps flowing between turns (a background child keeps running
 * after the parent's turn ends), so tracking must live at session scope and
 * be fed before the no-active-turn gate drops events.
 */
export class OpenCodeSubsessionTracker {
  private readonly subsessions = new Map<string, AgentSubsession>();

  constructor(private readonly rootSessionId: string) {}

  /**
   * Ingest sessions enumerated from the children endpoint (create/resume
   * hydration). Event-derived state wins: seeding never overwrites the status
   * of an already-tracked subsession.
   */
  seed(seeds: readonly OpenCodeSubsessionSeed[]): boolean {
    let changed = false;
    for (const seed of seeds) {
      if (seed.id === this.rootSessionId) continue;
      const existing = this.subsessions.get(seed.id);
      if (existing) {
        if (existing.title === null && seed.title !== null) {
          this.subsessions.set(seed.id, { ...existing, title: seed.title });
          changed = true;
        }
        continue;
      }
      if (this.subsessions.size >= MAX_TRACKED_SUBSESSIONS) continue;
      this.subsessions.set(seed.id, {
        id: seed.id,
        title: seed.title,
        status: "idle",
        parentSessionId: seed.parentSessionId,
      });
      changed = true;
    }
    return changed;
  }

  /** Returns true when the tracked list changed and should be re-emitted. */
  handleEvent(event: OpenCodeEvent): boolean {
    switch (event.type) {
      case "session.created":
      case "session.updated":
        return this.upsertFromSessionInfo(event.properties.info, event.type === "session.created");
      case "session.status": {
        const status = event.properties.status.type === "idle" ? "idle" : "running";
        return this.setStatus(event.properties.sessionID, status);
      }
      case "session.idle":
        return this.setStatus(event.properties.sessionID, "idle");
      case "session.error": {
        const sessionId = event.properties.sessionID;
        return sessionId === undefined ? false : this.setStatus(sessionId, "error");
      }
      case "session.deleted":
        return this.deleteSubtree(event.properties.sessionID);
      default:
        return false;
    }
  }

  list(): AgentSubsession[] {
    return [...this.subsessions.values()];
  }

  private upsertFromSessionInfo(
    info: { id: string; parentID?: string; title: string },
    isCreated: boolean,
  ): boolean {
    const parentSessionId = info.parentID ?? null;
    if (parentSessionId === null) {
      // Roots are never subsessions of anything.
      return false;
    }
    const existing = this.subsessions.get(info.id);
    if (!existing) {
      const isKnownParent =
        parentSessionId === this.rootSessionId || this.subsessions.has(parentSessionId);
      if (!isKnownParent) {
        // Belongs to some other agent's session tree.
        return false;
      }
      if (this.subsessions.size >= MAX_TRACKED_SUBSESSIONS) {
        return false;
      }
      this.subsessions.set(info.id, {
        id: info.id,
        title: normalizeSubsessionTitle(info.title),
        // A freshly created child was spawned to do work; an update for a
        // session we have not seen yet carries no activity signal.
        status: isCreated ? "running" : "idle",
        parentSessionId,
      });
      return true;
    }
    const title = normalizeSubsessionTitle(info.title) ?? existing.title;
    if (title !== existing.title || parentSessionId !== existing.parentSessionId) {
      this.subsessions.set(info.id, { ...existing, title, parentSessionId });
      return true;
    }
    return false;
  }

  private setStatus(sessionId: string, status: AgentSubsession["status"]): boolean {
    const existing = this.subsessions.get(sessionId);
    if (!existing || existing.status === status) {
      return false;
    }
    this.subsessions.set(sessionId, { ...existing, status });
    return true;
  }

  private deleteSubtree(sessionId: string): boolean {
    let changed = this.subsessions.delete(sessionId);
    for (const [candidateId, sub] of this.subsessions) {
      if (sub.parentSessionId === sessionId) {
        changed = this.deleteSubtree(candidateId) || changed;
      }
    }
    return changed;
  }
}

function normalizeSubsessionTitle(title: string | null | undefined): string | null {
  const normalized = title?.trim();
  return normalized ? normalized : null;
}
