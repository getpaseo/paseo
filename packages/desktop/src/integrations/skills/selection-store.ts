import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SkillSelection } from "./operations.js";

export interface SkillSelectionStore {
  get(): Promise<SkillSelection>;
  set(selection: unknown): Promise<SkillSelection>;
}

interface PersistedSkillSelectionDocument {
  version: 1;
  selection: SkillSelection;
}

const SKILL_SELECTION_FILENAME = "skill-selection.json";

// Installs that predate the picker have no file. They keep every bundled skill,
// which is what they had before, and what `all` keeps meaning as the bundle grows.
const DEFAULT_SKILL_SELECTION: SkillSelection = { mode: "all" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function coerceSkillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(names)].sort();
}

/**
 * The one place an unvalidated selection becomes a `SkillSelection`. Whether a
 * name is actually in the bundle is not decided here — the catalog belongs to
 * the bundle directory, so `operations` resolves that against the live catalog.
 */
export function coerceSkillSelection(value: unknown): SkillSelection {
  if (!isRecord(value)) return DEFAULT_SKILL_SELECTION;
  if (value.mode === "all") return { mode: "all" };
  if (value.mode === "custom") return { mode: "custom", skills: coerceSkillNames(value.skills) };
  return DEFAULT_SKILL_SELECTION;
}

function coerceDocument(value: unknown): PersistedSkillSelectionDocument {
  const selection = isRecord(value)
    ? coerceSkillSelection(value.selection)
    : DEFAULT_SKILL_SELECTION;
  return { version: 1, selection };
}

export function createSkillSelectionStore({
  userDataPath,
}: {
  userDataPath: string;
}): SkillSelectionStore {
  const filePath = path.join(userDataPath, SKILL_SELECTION_FILENAME);
  let persistQueue: Promise<void> = Promise.resolve();

  async function persist(document: PersistedSkillSelectionDocument): Promise<void> {
    const write = async () => {
      await mkdir(userDataPath, { recursive: true });
      const tempFilePath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
      await writeFile(tempFilePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(tempFilePath, filePath);
    };
    const queued = persistQueue.then(write, write);
    persistQueue = queued.catch(() => undefined);
    await queued;
  }

  return {
    async get(): Promise<SkillSelection> {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        return DEFAULT_SKILL_SELECTION;
      }
      try {
        return coerceDocument(JSON.parse(raw)).selection;
      } catch {
        return DEFAULT_SKILL_SELECTION;
      }
    },

    async set(selection: unknown): Promise<SkillSelection> {
      const document = coerceDocument({ selection });
      await persist(document);
      return document.selection;
    },
  };
}
