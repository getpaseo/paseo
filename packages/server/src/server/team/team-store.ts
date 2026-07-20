import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { z } from "zod";
import {
  TeamSchema,
  TeamCreateInputSchema,
  TeamUpdateInputSchema,
  type Team,
  type TeamCreateInput,
  type TeamUpdateInput,
} from "@getpaseo/protocol/messages";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

const TEAM_STORE_VERSION = 1;

const TeamStorePayloadSchema = z.object({
  version: z.literal(TEAM_STORE_VERSION),
  teams: z.array(TeamSchema),
});

type TeamStorePayload = z.infer<typeof TeamStorePayloadSchema>;

function createDefaultPayload(): TeamStorePayload {
  return { version: TEAM_STORE_VERSION, teams: [] };
}

function clonePayload(payload: TeamStorePayload): TeamStorePayload {
  return TeamStorePayloadSchema.parse(JSON.parse(JSON.stringify(payload)));
}

function nowMs(): number {
  return Date.now();
}

export class TeamStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private loaded = false;
  private payload: TeamStorePayload = createDefaultPayload();

  constructor(options: { paseoHome: string; logger: pino.Logger }) {
    this.filePath = path.join(options.paseoHome, "teams.json");
    this.logger = options.logger.child({ module: "team-store" });
  }

  list(): Team[] {
    this.ensureLoaded();
    return clonePayload(this.payload).teams;
  }

  get(id: string): Team | null {
    this.ensureLoaded();
    return this.payload.teams.find((team) => team.id === id) ?? null;
  }

  create(input: TeamCreateInput): Team {
    this.ensureLoaded();
    const parsed = TeamCreateInputSchema.parse(input);
    const timestamp = nowMs();
    const team = TeamSchema.parse({
      id: randomUUID(),
      userId: "local",
      name: parsed.name,
      workspace: parsed.workspace,
      workspaceMode: parsed.workspaceMode ?? "shared",
      leaderAssistantId: parsed.leaderAssistantId ?? "",
      assistants: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.replaceAndPersist({ ...this.payload, teams: [...this.payload.teams, team] });
    return team;
  }

  update(input: TeamUpdateInput): Team | null {
    this.ensureLoaded();
    const parsed = TeamUpdateInputSchema.parse(input);
    const index = this.payload.teams.findIndex((team) => team.id === parsed.id);
    if (index < 0) return null;
    const current = this.payload.teams[index]!;
    const team = TeamSchema.parse({
      ...current,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.workspace !== undefined ? { workspace: parsed.workspace } : {}),
      ...(parsed.workspaceMode !== undefined ? { workspaceMode: parsed.workspaceMode } : {}),
      ...(parsed.sessionMode !== undefined ? { sessionMode: parsed.sessionMode } : {}),
      updatedAt: nowMs(),
    });
    const teams = [...this.payload.teams];
    teams[index] = team;
    this.replaceAndPersist({ ...this.payload, teams });
    return team;
  }

  delete(id: string): boolean {
    this.ensureLoaded();
    const teams = this.payload.teams.filter((team) => team.id !== id);
    if (teams.length === this.payload.teams.length) return false;
    this.replaceAndPersist({ ...this.payload, teams });
    return true;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    if (!existsSync(this.filePath)) {
      this.payload = createDefaultPayload();
      this.loaded = true;
      return;
    }
    ensurePrivateFile(this.filePath);
    const raw = readFileSync(this.filePath, "utf8");
    try {
      this.payload = TeamStorePayloadSchema.parse(JSON.parse(raw));
    } catch (error) {
      this.logger.error({ err: error, filePath: this.filePath }, "Failed to parse team store");
      throw error;
    }
    this.loaded = true;
  }

  private replaceAndPersist(payload: TeamStorePayload): void {
    const parsed = TeamStorePayloadSchema.parse(payload);
    writePrivateFileAtomicSync(this.filePath, JSON.stringify(parsed, null, 2));
    this.payload = parsed;
    this.loaded = true;
  }
}
