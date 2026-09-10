import {
  Skia,
  listFontFamilies,
  matchFont,
  type SkFont,
  type SkParagraph,
} from "@shopify/react-native-skia";
import { fragmentTextForRange, visibleRowRange } from "./model";
import { codeTextColor } from "./palette";
import {
  createCachedAsciiTextMetrics,
  createChunkedAdvanceMeasurer,
  requiresShaping,
  type CachedAsciiTextMetrics,
} from "./text-measurement";
import type { DiffCell, DiffDocumentModel, DiffFragment, DiffPalette, TextMeasurer } from "./types";

const PARAGRAPH_WIDTH = 100_000;

export interface NativeTextLayout {
  font: SkFont;
  paragraphs: Array<Array<Array<SkParagraph | null>>>;
}

export interface NativeHeaderTextLayout {
  families: string[] | undefined;
  fontSize: number;
  statFontSize: number;
  palette: Pick<DiffPalette, "foreground" | "foregroundMuted" | "statusSuccess" | "statusDanger">;
}

export interface NativeShapedHeaderText {
  paragraph: SkParagraph;
  width: number;
  height: number;
}

export type NativeHeaderTextTone = keyof NativeHeaderTextLayout["palette"];

export function createNativeHeaderTextLayout(input: {
  configuredFamily: string;
  fontSize: number;
  statFontSize: number;
  palette: NativeHeaderTextLayout["palette"];
}): NativeHeaderTextLayout {
  const configured = input.configuredFamily
    .split(",")
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ""))
    // These are React Native's platform-default UI sentinels, not custom faces.
    // Omitting the family lets Skia resolve the same platform system font.
    .filter((family) => family && family !== "normal" && family !== "system-ui");
  const families = configured.length > 0 ? [...new Set(configured)] : undefined;
  return {
    families,
    fontSize: input.fontSize,
    statFontSize: input.statFontSize,
    palette: input.palette,
  };
}

export function shapeNativeHeaderText(input: {
  layout: NativeHeaderTextLayout;
  text: string;
  size: "body" | "stat";
  tone: NativeHeaderTextTone;
  maximumWidth?: number;
}): NativeShapedHeaderText {
  const paragraph = Skia.ParagraphBuilder.Make({ maxLines: 1, ellipsis: "…" })
    .pushStyle({
      ...(input.layout.families ? { fontFamilies: input.layout.families } : {}),
      fontSize: input.size === "body" ? input.layout.fontSize : input.layout.statFontSize,
      color: Skia.Color(input.layout.palette[input.tone]),
    })
    .addText(input.text)
    .pop()
    .build();
  paragraph.layout(input.maximumWidth ?? PARAGRAPH_WIDTH);
  return {
    paragraph,
    width: paragraph.getLongestLine(),
    height: paragraph.getHeight(),
  };
}

export interface NativeTextLayoutStore {
  font: SkFont;
  asciiMetrics: CachedAsciiTextMetrics;
  paragraphsByCell: Map<DiffCell, Array<SkParagraph | null>>;
  textStyles: Map<string, ReturnType<typeof textStyle>>;
  ownedParagraphs: Set<SkParagraph>;
  families: string[];
  fontSize: number;
  lineHeight: number;
  palette: DiffPalette;
}

export function disposeNativeTextLayout(layout: NativeTextLayoutStore): void {
  for (const paragraph of layout.ownedParagraphs) paragraph.dispose();
  layout.ownedParagraphs.clear();
  layout.paragraphsByCell.clear();
  layout.textStyles.clear();
  layout.font.dispose();
}

export function createNativeTextLayoutStore(input: {
  configuredFamily: string;
  fontSize: number;
  lineHeight: number;
  palette: DiffPalette;
}): NativeTextLayoutStore {
  const families = nativeFontFamilies(input.configuredFamily);
  const font = primaryFont(families, input.fontSize);
  return {
    font,
    asciiMetrics: createCachedAsciiTextMetrics({
      glyphIds: (text) => font.getGlyphIDs(text),
      measure: (text) => font.getTextWidth(text),
    }),
    paragraphsByCell: new Map(),
    textStyles: new Map(),
    ownedParagraphs: new Set(),
    families,
    fontSize: input.fontSize,
    lineHeight: input.lineHeight,
    palette: input.palette,
  };
}

export function prepareNativeTextLayout(
  store: NativeTextLayoutStore,
  model: DiffDocumentModel,
  window?: { top: number; height: number },
): NativeTextLayout {
  const range = window
    ? visibleRowRange(model.rows, window.top, window.height)
    : { start: 0, end: model.rows.length };
  const retainedCells = new Set<DiffCell>();
  const retainedParagraphs = new Set<SkParagraph>();
  const paragraphs: NativeTextLayout["paragraphs"] = [];
  paragraphs.length = model.rows.length;
  for (let index = range.start; index < range.end; index++) {
    const row = model.rows[index]!;
    if (row.kind !== "line") continue;
    paragraphs[index] = row.cells.map((cell) => {
      if (!cell) return [];
      retainedCells.add(cell);
      const cached = store.paragraphsByCell.get(cell);
      const start = window ? Math.max(0, Math.floor((window.top - row.top) / model.lineHeight)) : 0;
      const end = window
        ? Math.min(
            cell.fragments.length,
            Math.ceil((window.top + window.height - row.top) / model.lineHeight),
          )
        : cell.fragments.length;
      const cellParagraphs: Array<SkParagraph | null> = [];
      cellParagraphs.length = cell.fragments.length;
      for (let fragmentIndex = start; fragmentIndex < end; fragmentIndex++) {
        const fragment = cell.fragments[fragmentIndex]!;
        if (!requiresRetainedParagraph(fragment.text, store.asciiMetrics)) {
          cellParagraphs[fragmentIndex] = null;
          continue;
        }
        const paragraph =
          cached?.[fragmentIndex] ??
          createFragmentParagraph({
            cell,
            fragment,
            families: store.families,
            fontSize: store.fontSize,
            lineHeight: store.lineHeight,
            palette: store.palette,
            textStyles: store.textStyles,
          });
        store.ownedParagraphs.add(paragraph);
        retainedParagraphs.add(paragraph);
        cellParagraphs[fragmentIndex] = paragraph;
      }
      store.paragraphsByCell.set(cell, cellParagraphs);
      return cellParagraphs;
    });
  }
  for (const paragraph of store.ownedParagraphs) {
    if (retainedParagraphs.has(paragraph)) continue;
    paragraph.dispose();
    store.ownedParagraphs.delete(paragraph);
  }
  for (const cell of store.paragraphsByCell.keys()) {
    if (!retainedCells.has(cell)) store.paragraphsByCell.delete(cell);
  }
  return { font: store.font, paragraphs };
}

export function createNativeTextMeasurer(input: {
  configuredFamily: string;
  fontSize: number;
}): TextMeasurer {
  const families = nativeFontFamilies(input.configuredFamily);
  const font = primaryFont(families, input.fontSize);
  const primary = {
    glyphIds: (text: string) => font.getGlyphIDs(text),
    measure: (text: string) => font.getTextWidth(text),
  };
  const asciiMetrics = createCachedAsciiTextMetrics(primary);
  const black = Skia.Color("black");
  const measureParagraph = (text: string) => {
    const paragraph = createParagraph({
      text,
      families,
      fontSize: input.fontSize,
      lineHeight: Math.round(input.fontSize * 1.5),
      color: black,
    });
    const width = paragraph.getLongestLine();
    paragraph.dispose();
    return width;
  };
  return {
    measure(text) {
      return requiresRetainedParagraph(text, asciiMetrics)
        ? measureParagraph(text)
        : asciiMetrics.measure(text);
    },
    measureAdvances: createChunkedAdvanceMeasurer({
      requiresShaping: (text) => requiresRetainedParagraph(text, asciiMetrics),
      measureAdditive: (graphemes) => asciiMetrics.measureAdvances(graphemes),
      measureShaped(graphemes) {
        const paragraph = createParagraph({
          text: graphemes.join(""),
          families,
          fontSize: input.fontSize,
          lineHeight: Math.round(input.fontSize * 1.5),
          color: black,
        });
        let end = 0;
        const advances = graphemes.map((grapheme) => {
          end += grapheme.length;
          const rectangles = paragraph.getRectsForRange(0, end);
          return rectangles.reduce(
            (right, rectangle) => Math.max(right, rectangle.x + rectangle.width),
            0,
          );
        });
        paragraph.dispose();
        return advances;
      },
    }),
  };
}

function requiresRetainedParagraph(text: string, asciiMetrics: CachedAsciiTextMetrics): boolean {
  return requiresShaping(text) || !asciiMetrics.hasEveryGlyph(text);
}

function createFragmentParagraph(input: {
  cell: DiffCell;
  fragment: DiffFragment;
  families: string[];
  fontSize: number;
  lineHeight: number;
  palette: DiffPalette;
  textStyles: NativeTextLayoutStore["textStyles"];
}): SkParagraph {
  const builder = Skia.ParagraphBuilder.Make(
    paragraphStyle(input.families, input.fontSize, input.lineHeight),
  );
  if (input.cell.tokens.length === 0 || input.cell.type === "header") {
    const color = codeTextColor(input.cell, input.palette);
    builder.pushStyle(retainedTextStyle(input, color)).addText(input.fragment.text).pop();
  } else {
    for (const run of input.cell.tokens) {
      const start = Math.max(input.fragment.start, run.start);
      const end = Math.min(input.fragment.end, run.end);
      if (end <= start) continue;
      builder
        .pushStyle(retainedTextStyle(input, run.color))
        .addText(fragmentTextForRange(input.fragment, start, end))
        .pop();
    }
  }
  const paragraph = builder.build();
  paragraph.layout(PARAGRAPH_WIDTH);
  return paragraph;
}

function createParagraph(input: {
  text: string;
  families: string[];
  fontSize: number;
  lineHeight: number;
  color: ReturnType<typeof Skia.Color>;
}): SkParagraph {
  const paragraph = Skia.ParagraphBuilder.Make(
    paragraphStyle(input.families, input.fontSize, input.lineHeight),
  )
    .pushStyle({
      fontFamilies: input.families,
      fontSize: input.fontSize,
      color: input.color,
    })
    .addText(input.text)
    .pop()
    .build();
  paragraph.layout(PARAGRAPH_WIDTH);
  return paragraph;
}

function paragraphStyle(families: string[], fontSize: number, lineHeight: number) {
  return {
    maxLines: 1,
    strutStyle: {
      strutEnabled: true,
      forceStrutHeight: true,
      fontFamilies: families,
      fontSize,
      heightMultiplier: lineHeight / fontSize,
      halfLeading: true,
    },
  };
}

function retainedTextStyle(
  input: { families: string[]; fontSize: number; textStyles: NativeTextLayoutStore["textStyles"] },
  color: string,
) {
  let style = input.textStyles.get(color);
  if (!style) {
    style = textStyle(input.families, input.fontSize, color);
    input.textStyles.set(color, style);
  }
  return style;
}

function textStyle(families: string[], fontSize: number, color: string) {
  return { fontFamilies: families, fontSize, color: Skia.Color(color) };
}

function primaryFont(families: string[], size: number): SkFont {
  const available = new Set(listFontFamilies());
  const family = families.find((candidate) => available.has(candidate)) ?? "System";
  return matchFont({ fontFamily: family, fontSize: size });
}

export function nativeFontFamilies(configuredFamily: string): string[] {
  const configured = configuredFamily
    .split(",")
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  return [...new Set([...configured, "Menlo", "SF Mono", "monospace", "System"])];
}
