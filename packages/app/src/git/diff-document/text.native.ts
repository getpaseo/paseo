import {
  Skia,
  listFontFamilies,
  matchFont,
  type SkFont,
  type SkParagraph,
} from "@shopify/react-native-skia";
import { fragmentTextForRange } from "./model";
import { codeTextColor } from "./palette";
import {
  createCachedAsciiTextMetrics,
  createChunkedAdvanceMeasurer,
  createFallbackAwareTextMeasurer,
  requiresShaping,
  type CachedAsciiTextMetrics,
} from "./text-measurement";
import type { DiffCell, DiffDocumentModel, DiffFragment, DiffPalette, TextMeasurer } from "./types";

const PARAGRAPH_WIDTH = 100_000;

export interface NativeTextLayout {
  font: SkFont;
  paragraphs: Array<Array<Array<SkParagraph | null>>>;
}

export interface NativeTextLayoutStore {
  font: SkFont;
  asciiMetrics: CachedAsciiTextMetrics;
  paragraphsByCell: WeakMap<DiffCell, Array<SkParagraph | null>>;
  ownedParagraphs: Set<SkParagraph>;
  families: string[];
  fontSize: number;
  lineHeight: number;
  palette: DiffPalette;
}

export function disposeNativeTextLayout(layout: NativeTextLayoutStore): void {
  for (const paragraph of layout.ownedParagraphs) paragraph.dispose();
  layout.ownedParagraphs.clear();
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
    paragraphsByCell: new WeakMap(),
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
): NativeTextLayout {
  const paragraphs = model.rows.map((row) => {
    if (row.kind !== "line") return [];
    return row.cells.map((cell) => {
      if (!cell) return [];
      const cached = store.paragraphsByCell.get(cell);
      if (cached) return cached;
      const cellParagraphs = cell.fragments.map((fragment) => {
        if (!requiresRetainedParagraph(fragment.text, store.asciiMetrics)) return null;
        const paragraph = createFragmentParagraph({
          cell,
          fragment,
          families: store.families,
          fontSize: store.fontSize,
          lineHeight: store.lineHeight,
          palette: store.palette,
        });
        store.ownedParagraphs.add(paragraph);
        return paragraph;
      });
      store.paragraphsByCell.set(cell, cellParagraphs);
      return cellParagraphs;
    });
  });
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
  const fallbackAware = createFallbackAwareTextMeasurer({
    primary,
    measureWithSystemFallback(text) {
      const paragraph = createParagraph({
        text,
        families,
        fontSize: input.fontSize,
        lineHeight: Math.round(input.fontSize * 1.5),
        color: Skia.Color("black"),
      });
      const width = paragraph.getLongestLine();
      paragraph.dispose();
      return width;
    },
  });
  return {
    ...fallbackAware,
    measureAdvances: createChunkedAdvanceMeasurer({
      requiresShaping: (text) => requiresRetainedParagraph(text, asciiMetrics),
      measureAdditive: (graphemes) => asciiMetrics.measureAdvances(graphemes),
      measureShaped(graphemes) {
        const paragraph = createParagraph({
          text: graphemes.join(""),
          families,
          fontSize: input.fontSize,
          lineHeight: Math.round(input.fontSize * 1.5),
          color: Skia.Color("black"),
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
}): SkParagraph {
  const builder = Skia.ParagraphBuilder.Make(
    paragraphStyle(input.families, input.fontSize, input.lineHeight),
  );
  if (input.cell.tokens.length === 0 || input.cell.type === "header") {
    const color = codeTextColor(input.cell, input.palette);
    builder
      .pushStyle(textStyle(input.families, input.fontSize, color))
      .addText(input.fragment.text)
      .pop();
  } else {
    for (const run of input.cell.tokens) {
      const start = Math.max(input.fragment.start, run.start);
      const end = Math.min(input.fragment.end, run.end);
      if (end <= start) continue;
      builder
        .pushStyle(textStyle(input.families, input.fontSize, run.color))
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
