import type {
  SourceChange,
  SourceEditorConfiguration,
  SourceEditorPosition,
  SourceEditorSelectionTarget,
} from "../contract";

export type SourceEditorHostMessage =
  | {
      type: "mount";
      editorKey: string;
      document: string;
      configuration: SourceEditorConfiguration;
    }
  | { type: "replaceDocument"; editorKey: string; document: string }
  | { type: "configure"; editorKey: string; configuration: SourceEditorConfiguration }
  | ({ type: "reveal"; editorKey: string } & SourceEditorSelectionTarget)
  | { type: "destroy"; editorKey: string };

export type SourceEditorBridgeMessage =
  | { type: "bridgeReady" }
  | { type: "ready"; editorKey: string }
  | { type: "change"; editorKey: string; changes: readonly SourceChange[] }
  | ({ type: "cursor"; editorKey: string } & SourceEditorPosition)
  | { type: "save"; editorKey: string }
  | { type: "vimMode"; editorKey: string; mode: string | null };

export function parseSourceEditorBridgeMessage(value: string): SourceEditorBridgeMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
  if (parsed.type === "bridgeReady") return { type: "bridgeReady" };
  if (typeof parsed.editorKey !== "string") return null;
  switch (parsed.type) {
    case "ready":
    case "save":
      return { type: parsed.type, editorKey: parsed.editorKey };
    case "vimMode":
      return parsed.mode === null || typeof parsed.mode === "string"
        ? { type: "vimMode", editorKey: parsed.editorKey, mode: parsed.mode }
        : null;
    case "cursor":
      return isPositiveInteger(parsed.line) && isPositiveInteger(parsed.column)
        ? {
            type: "cursor",
            editorKey: parsed.editorKey,
            line: parsed.line,
            column: parsed.column,
          }
        : null;
    case "change": {
      const changes = parseChanges(parsed.changes);
      return changes ? { type: "change", editorKey: parsed.editorKey, changes } : null;
    }
    default:
      return null;
  }
}

export function parseSourceEditorHostMessage(value: string): SourceEditorHostMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.type !== "string" ||
    typeof parsed.editorKey !== "string"
  ) {
    return null;
  }
  switch (parsed.type) {
    case "mount":
      return typeof parsed.document === "string" && isConfiguration(parsed.configuration)
        ? {
            type: "mount",
            editorKey: parsed.editorKey,
            document: parsed.document,
            configuration: parsed.configuration,
          }
        : null;
    case "replaceDocument":
      return typeof parsed.document === "string"
        ? { type: "replaceDocument", editorKey: parsed.editorKey, document: parsed.document }
        : null;
    case "configure":
      return isConfiguration(parsed.configuration)
        ? { type: "configure", editorKey: parsed.editorKey, configuration: parsed.configuration }
        : null;
    case "reveal":
      return isPositiveInteger(parsed.lineStart) &&
        (parsed.lineEnd === undefined || isPositiveInteger(parsed.lineEnd)) &&
        Number.isInteger(parsed.revision)
        ? {
            type: "reveal",
            editorKey: parsed.editorKey,
            lineStart: parsed.lineStart,
            lineEnd: parsed.lineEnd,
            revision: parsed.revision as number,
          }
        : null;
    case "destroy":
      return { type: "destroy", editorKey: parsed.editorKey };
    default:
      return null;
  }
}

function parseChanges(value: unknown): SourceChange[] | null {
  if (!Array.isArray(value)) return null;
  const changes: SourceChange[] = [];
  for (const change of value) {
    if (
      !isRecord(change) ||
      !Number.isInteger(change.from) ||
      !Number.isInteger(change.to) ||
      typeof change.insert !== "string"
    ) {
      return null;
    }
    changes.push({ from: change.from as number, to: change.to as number, insert: change.insert });
  }
  return changes;
}

function isConfiguration(value: unknown): value is SourceEditorConfiguration {
  if (
    !isRecord(value) ||
    typeof value.filename !== "string" ||
    typeof value.vimEnabled !== "boolean"
  ) {
    return false;
  }
  const theme = value.theme;
  return (
    isRecord(theme) &&
    (theme.colorScheme === "light" || theme.colorScheme === "dark") &&
    typeof theme.background === "string" &&
    typeof theme.foreground === "string" &&
    typeof theme.cursor === "string" &&
    typeof theme.foregroundMuted === "string" &&
    typeof theme.border === "string" &&
    typeof theme.selection === "string" &&
    typeof theme.monoFont === "string" &&
    typeof theme.codeFontSize === "number" &&
    isRecord(theme.syntax)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}
