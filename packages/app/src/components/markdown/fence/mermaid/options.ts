import type {
  MermaidColors,
  MermaidCurve,
  MermaidDiagramOptions,
  MermaidFrame,
  MermaidLook,
  MermaidNodeShape,
} from "@getpaseo/plugin/client/ui";

/** Style sent into the sandbox. The preview frame stays on the host. */
export type MermaidRuntimeStyle = Omit<MermaidDiagramOptions, "frame">;

const COLOR_KEYS = new Set<keyof MermaidColors>([
  "primaryColor",
  "primaryTextColor",
  "primaryBorderColor",
  "secondaryColor",
  "secondaryTextColor",
  "secondaryBorderColor",
  "tertiaryColor",
  "tertiaryTextColor",
  "tertiaryBorderColor",
  "lineColor",
  "textColor",
  "clusterBkg",
  "clusterBorder",
  "edgeLabelBackground",
  "titleColor",
]);

const STYLE_KEYS = new Set<keyof MermaidRuntimeStyle>([
  "colors",
  "radius",
  "strokeWidth",
  "fontFamily",
  "fontSize",
  "look",
  "curve",
  "nodeSpacing",
  "rankSpacing",
  "padding",
  "diagramPadding",
  "defaultShape",
]);

const LOOKS = new Set<MermaidLook>(["classic", "handDrawn", "neo"]);

const CURVES = new Set<MermaidCurve>([
  "basis",
  "bumpX",
  "bumpY",
  "cardinal",
  "catmullRom",
  "linear",
  "monotoneX",
  "monotoneY",
  "natural",
  "step",
  "stepAfter",
  "stepBefore",
  "rounded",
]);

const SHAPES = new Set<MermaidNodeShape>([
  "rect",
  "rounded",
  "stadium",
  "subroutine",
  "cylinder",
  "circle",
  "diamond",
  "hexagon",
]);

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ,.'"-]{0,63}$/;

export interface MermaidFrameStyle {
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  padding?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): T | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.has(value)) return null;
  return value as T;
}

function optionalInteger(value: unknown, min: number, max: number): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

function parseFontFamily(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !FONT_FAMILY.test(value)) return null;
  return value;
}

function parseColors(value: unknown): MermaidColors | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const colors: MermaidColors = {};
  for (const [key, color] of Object.entries(value)) {
    if (!COLOR_KEYS.has(key as keyof MermaidColors)) return null;
    if (color === undefined) continue;
    if (typeof color !== "string" || !HEX_COLOR.test(color)) return null;
    colors[key as keyof MermaidColors] = color;
  }
  return colors;
}

function assign<T>(
  style: MermaidRuntimeStyle,
  key: keyof MermaidRuntimeStyle,
  value: T | undefined | null,
): boolean {
  if (value === null) return false;
  if (value !== undefined) {
    style[key] = value as never;
  }
  return true;
}

/**
 * Accepts a sandbox style payload. `undefined` means the field was absent.
 * `null` rejects the whole render message.
 */
export function parseMermaidRuntimeStyle(value: unknown): MermaidRuntimeStyle | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !STYLE_KEYS.has(key as keyof MermaidRuntimeStyle))) {
    return null;
  }
  const style: MermaidRuntimeStyle = {};
  const colors = parseColors(value.colors);
  const fontFamily = parseFontFamily(value.fontFamily);
  const ok =
    assign(style, "colors", colors) &&
    assign(style, "radius", optionalInteger(value.radius, 0, 40)) &&
    assign(style, "strokeWidth", optionalInteger(value.strokeWidth, 0, 8)) &&
    assign(style, "fontFamily", fontFamily) &&
    assign(style, "fontSize", optionalInteger(value.fontSize, 8, 32)) &&
    assign(style, "look", optionalEnum<MermaidLook>(value.look, LOOKS)) &&
    assign(style, "curve", optionalEnum<MermaidCurve>(value.curve, CURVES)) &&
    assign(style, "nodeSpacing", optionalInteger(value.nodeSpacing, 0, 240)) &&
    assign(style, "rankSpacing", optionalInteger(value.rankSpacing, 0, 240)) &&
    assign(style, "padding", optionalInteger(value.padding, 0, 80)) &&
    assign(style, "diagramPadding", optionalInteger(value.diagramPadding, 0, 80)) &&
    assign(style, "defaultShape", optionalEnum<MermaidNodeShape>(value.defaultShape, SHAPES));
  if (!ok) return null;
  return Object.keys(style).length > 0 ? style : undefined;
}

export function mergeMermaidOptions(
  mermaidColors: MermaidColors | undefined,
  mermaid: MermaidDiagramOptions | undefined,
): MermaidDiagramOptions | undefined {
  if (!mermaid && !mermaidColors) return undefined;
  const mergedColors = { ...mermaidColors, ...mermaid?.colors };
  const colors = Object.fromEntries(
    Object.entries(mergedColors).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  ) as MermaidColors;
  const { colors: _colors, ...rest } = mermaid ?? {};
  const options: MermaidDiagramOptions = { ...rest };
  if (Object.keys(colors).length > 0) options.colors = colors;
  return Object.keys(options).length > 0 ? options : undefined;
}

export function runtimeStyleOf(
  options: MermaidDiagramOptions | undefined,
): MermaidRuntimeStyle | undefined {
  if (!options) return undefined;
  const style: MermaidDiagramOptions = { ...options };
  delete style.frame;
  const defined = Object.fromEntries(
    Object.entries(style).filter(([, value]) => value !== undefined),
  ) as MermaidRuntimeStyle;
  return Object.keys(defined).length > 0 ? defined : undefined;
}

/** Drops the whole frame when any field is present and invalid. */
export function mermaidFrameStyle(frame: unknown): MermaidFrameStyle {
  if (frame === undefined) return {};
  if (!isRecord(frame)) return {};
  const allowed = new Set<keyof MermaidFrame>([
    "backgroundColor",
    "borderColor",
    "borderRadius",
    "padding",
  ]);
  if (Object.keys(frame).some((key) => !allowed.has(key as keyof MermaidFrame))) return {};
  const backgroundColor = frame.backgroundColor;
  const borderColor = frame.borderColor;
  const borderRadius = optionalInteger(frame.borderRadius, 0, 40);
  const padding = optionalInteger(frame.padding, 0, 48);
  if (
    (backgroundColor !== undefined &&
      (typeof backgroundColor !== "string" || !HEX_COLOR.test(backgroundColor))) ||
    (borderColor !== undefined &&
      (typeof borderColor !== "string" || !HEX_COLOR.test(borderColor))) ||
    borderRadius === null ||
    padding === null
  ) {
    return {};
  }
  return {
    ...(typeof backgroundColor === "string" ? { backgroundColor } : {}),
    ...(typeof borderColor === "string" ? { borderColor, borderWidth: 1 } : {}),
    ...(borderRadius !== undefined ? { borderRadius } : {}),
    ...(padding !== undefined ? { padding } : {}),
  };
}
