import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { z } from "zod";
import {
  SkillSchema,
  SkillCreateInputSchema,
  SkillUpdateInputSchema,
  type Skill,
  type SkillCreateInput,
  type SkillUpdateInput,
} from "@getpaseo/protocol/messages";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

const SKILL_STORE_VERSION = 1;

const SkillStorePayloadSchema = z.object({
  version: z.literal(SKILL_STORE_VERSION),
  skills: z.array(SkillSchema),
});

type SkillStorePayload = z.infer<typeof SkillStorePayloadSchema>;

function createDefaultPayload(): SkillStorePayload {
  return { version: SKILL_STORE_VERSION, skills: [] };
}

function clonePayload(payload: SkillStorePayload): SkillStorePayload {
  return SkillStorePayloadSchema.parse(JSON.parse(JSON.stringify(payload)));
}

function nowMs(): number {
  return Date.now();
}

export class SkillStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private loaded = false;
  private payload: SkillStorePayload = createDefaultPayload();

  constructor(options: { paseoHome: string; logger: pino.Logger }) {
    this.filePath = path.join(options.paseoHome, "skills.json");
    this.logger = options.logger.child({ module: "skill-store" });
  }

  list(): Skill[] {
    this.ensureLoaded();
    return clonePayload(this.payload).skills;
  }

  get(id: string): Skill | null {
    this.ensureLoaded();
    return this.payload.skills.find((skill) => skill.id === id) ?? null;
  }

  create(input: SkillCreateInput): Skill {
    this.ensureLoaded();
    const parsed = SkillCreateInputSchema.parse(input);
    const timestamp = nowMs();
    const skill = SkillSchema.parse({
      id: randomUUID(),
      name: parsed.name,
      description: parsed.description,
      source: "user",
      enabled: true,
      content: parsed.content,
      tags: parsed.tags ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.replaceAndPersist({ ...this.payload, skills: [...this.payload.skills, skill] });
    return skill;
  }

  update(input: SkillUpdateInput): Skill | null {
    this.ensureLoaded();
    const parsed = SkillUpdateInputSchema.parse(input);
    const index = this.payload.skills.findIndex((skill) => skill.id === parsed.id);
    if (index < 0) return null;
    const current = this.payload.skills[index]!;
    const skill = SkillSchema.parse({
      ...current,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      ...(parsed.content !== undefined ? { content: parsed.content } : {}),
      ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
      ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
      updatedAt: nowMs(),
    });
    const skills = [...this.payload.skills];
    skills[index] = skill;
    this.replaceAndPersist({ ...this.payload, skills });
    return skill;
  }

  delete(id: string): boolean {
    this.ensureLoaded();
    const skills = this.payload.skills.filter((skill) => skill.id !== id);
    if (skills.length === this.payload.skills.length) return false;
    this.replaceAndPersist({ ...this.payload, skills });
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
      this.payload = SkillStorePayloadSchema.parse(JSON.parse(raw));
    } catch (error) {
      this.logger.error({ err: error, filePath: this.filePath }, "Failed to parse skill store");
      throw error;
    }
    this.loaded = true;
  }

  private replaceAndPersist(payload: SkillStorePayload): void {
    const parsed = SkillStorePayloadSchema.parse(payload);
    writePrivateFileAtomicSync(this.filePath, JSON.stringify(parsed, null, 2));
    this.payload = parsed;
    this.loaded = true;
  }
}
