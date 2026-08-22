import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

type AgentSkillSelection = { mode: "all" } | { mode: "custom"; skills: string[] };

const LEGACY_FILENAME = "skill-selection.json";

function parseSelection(value: unknown): AgentSkillSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { mode: "all" };
  const document = value as { selection?: unknown };
  if (!document.selection || typeof document.selection !== "object") return { mode: "all" };
  const selection = document.selection as { mode?: unknown; skills?: unknown };
  if (selection.mode === "all") return { mode: "all" };
  if (selection.mode !== "custom" || !Array.isArray(selection.skills)) return { mode: "all" };
  return {
    mode: "custom",
    skills: [
      ...new Set(
        selection.skills
          .filter((name): name is string => typeof name === "string")
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    ].sort(),
  };
}

function legacyPath(): string {
  return path.join(app.getPath("userData"), LEGACY_FILENAME);
}

// COMPAT(desktopSkillSelectionMigration): added in v0.4.0; remove after 2027-02-16.
export async function readLegacySkillSelection(): Promise<AgentSkillSelection | null> {
  const raw = await readFile(legacyPath(), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return null;
  try {
    return parseSelection(JSON.parse(raw));
  } catch {
    return { mode: "all" };
  }
}

// COMPAT(desktopSkillSelectionMigration): added in v0.4.0; remove after 2027-02-16.
export async function deleteLegacySkillSelection(): Promise<void> {
  await rm(legacyPath(), { force: true });
}
