import type { DiagramColorScheme, DiagramDimensions } from "../render-model";

export interface MermaidRuntimeRenderMessage {
  type: "render";
  revision: number;
  source: string;
  colorScheme: DiagramColorScheme;
  interactive: boolean;
}

export type MermaidRuntimeMessage =
  | { type: "bridgeReady" }
  | ({
      type: "rendered";
      revision: number;
      source: string;
      colorScheme: DiagramColorScheme;
    } & DiagramDimensions)
  | { type: "renderError"; revision: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isColorScheme(value: unknown): value is DiagramColorScheme {
  return value === "light" || value === "dark";
}

export function parseMermaidRuntimeRenderMessage(
  value: unknown,
): MermaidRuntimeRenderMessage | null {
  if (
    !isRecord(value) ||
    value.type !== "render" ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    typeof value.source !== "string" ||
    !isColorScheme(value.colorScheme) ||
    typeof value.interactive !== "boolean"
  ) {
    return null;
  }
  return {
    type: "render",
    revision: value.revision,
    source: value.source,
    colorScheme: value.colorScheme,
    interactive: value.interactive,
  };
}

export function parseMermaidRuntimeMessage(value: unknown): MermaidRuntimeMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  if (value.type === "bridgeReady") {
    return { type: "bridgeReady" };
  }
  if (
    value.type === "renderError" &&
    typeof value.revision === "number" &&
    Number.isInteger(value.revision)
  ) {
    return { type: "renderError", revision: value.revision };
  }
  if (
    value.type === "rendered" &&
    typeof value.revision === "number" &&
    Number.isInteger(value.revision) &&
    typeof value.source === "string" &&
    isColorScheme(value.colorScheme) &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width)
  ) {
    return {
      type: "rendered",
      revision: value.revision,
      source: value.source,
      colorScheme: value.colorScheme,
      height: value.height,
      width: value.width,
    };
  }
  return null;
}

export function serializeMermaidRuntimeRenderMessage(message: MermaidRuntimeRenderMessage): string {
  return JSON.stringify(message).replace(/<\/script/gi, "<\\/script");
}
