export type SkillsState = "not-installed" | "up-to-date" | "drift";

export type SkillOp =
  | { kind: "add"; name: string }
  | { kind: "update"; name: string }
  | { kind: "delete"; name: string };

/** What the user asked to have installed. `all` follows the bundle as it grows. */
export type SkillSelection = { mode: "all" } | { mode: "custom"; skills: string[] };

export interface SkillsSnapshot {
  state: SkillsState;
  ops: SkillOp[];
  /** Every skill the host currently bundles, sorted. The selectable catalog. */
  available: string[];
  selection: SkillSelection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSkillsState(value: unknown): SkillsState {
  switch (value) {
    case "not-installed":
    case "up-to-date":
    case "drift":
      return value;
    default:
      throw new Error(`Unexpected skills status state: ${String(value)}`);
  }
}

function parseSkillOp(raw: unknown): SkillOp {
  if (!isRecord(raw)) {
    throw new Error("Unexpected skill op response.");
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) throw new Error("Skill op missing name.");
  switch (raw.kind) {
    case "add":
      return { kind: "add", name };
    case "update":
      return { kind: "update", name };
    case "delete":
      return { kind: "delete", name };
    default:
      throw new Error(`Unexpected skill op kind: ${String(raw.kind)}`);
  }
}

function parseSkillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseSkillSelection(value: unknown): SkillSelection {
  // A host that predates the picker sends no selection; it manages every
  // bundled skill, which is exactly what `all` means.
  if (!isRecord(value)) return { mode: "all" };
  if (value.mode === "custom") return { mode: "custom", skills: parseSkillNames(value.skills) };
  return { mode: "all" };
}

export function parseSkillsSnapshot(raw: unknown): SkillsSnapshot {
  if (!isRecord(raw)) {
    throw new Error("Unexpected skills status response.");
  }
  return {
    state: parseSkillsState(raw.state),
    ops: Array.isArray(raw.ops) ? raw.ops.map(parseSkillOp) : [],
    available: parseSkillNames(raw.available),
    selection: parseSkillSelection(raw.selection),
  };
}
