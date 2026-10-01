import { appendFile, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { type TeamEvent, TeamEventSchema, type TeamState, TeamStateSchema } from "./types.js";

export type TeamEventDraft = Omit<TeamEvent, "commit" | "at">;

export class StaleRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleRevisionError";
  }
}

/**
 * One directory per team: `state.json` (atomic) and `events.jsonl` (append-only).
 *
 * A commit appends its events tagged with the next commit number, fsyncs, then replaces
 * state.json. On load, events newer than state.json's commit are from a commit that never
 * landed and are dropped, so state and log never disagree after a crash.
 */
export class TeamStore {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, TeamState>();

  constructor(private readonly dir: string) {}

  private teamDir(teamId: string): string {
    return join(this.dir, teamId);
  }

  async listIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async get(teamId: string): Promise<TeamState | null> {
    const cached = this.cache.get(teamId);
    if (cached) return structuredClone(cached);
    let raw: string;
    try {
      raw = await readFile(join(this.teamDir(teamId), "state.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const state = TeamStateSchema.parse(JSON.parse(raw));
    await this.dropUncommittedEvents(teamId, state.commit);
    this.cache.set(teamId, state);
    return structuredClone(state);
  }

  async events(teamId: string): Promise<TeamEvent[]> {
    try {
      const raw = await readFile(join(this.teamDir(teamId), "events.jsonl"), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => TeamEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async create(state: TeamState, events: TeamEventDraft[]): Promise<void> {
    await mkdir(this.teamDir(state.team.id), { recursive: true });
    await this.write(state.team.id, { ...state, commit: 0 }, events);
  }

  /**
   * Serialized read-modify-write. `mutate` edits a draft and returns the events of the commit;
   * throwing aborts the commit with nothing written.
   */
  commit<T>(
    teamId: string,
    mutate: (
      draft: TeamState,
    ) => { events: TeamEventDraft[]; result: T } | Promise<{ events: TeamEventDraft[]; result: T }>,
  ): Promise<T> {
    const previous = this.chains.get(teamId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const draft = await this.get(teamId);
        if (!draft) throw new Error(`Team ${teamId} not found`);
        const { events, result } = await mutate(draft);
        await this.write(teamId, draft, events);
        return result;
      });
    this.chains.set(teamId, next);
    return next;
  }

  private async write(teamId: string, state: TeamState, events: TeamEventDraft[]): Promise<void> {
    const commit = state.commit + 1;
    const at = new Date().toISOString();
    if (events.length > 0) {
      const lines = events.map((e) => JSON.stringify({ ...e, commit, at })).join("\n") + "\n";
      const path = join(this.teamDir(teamId), "events.jsonl");
      await appendFile(path, lines);
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const next = { ...state, commit };
    await writeJsonFileAtomic(join(this.teamDir(teamId), "state.json"), next);
    this.cache.set(teamId, structuredClone(next));
  }

  private async dropUncommittedEvents(teamId: string, commit: number): Promise<void> {
    const events = await this.events(teamId);
    const kept = events.filter((e) => e.commit <= commit);
    if (kept.length === events.length) return;
    await writeFile(
      join(this.teamDir(teamId), "events.jsonl"),
      kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""),
    );
  }
}
