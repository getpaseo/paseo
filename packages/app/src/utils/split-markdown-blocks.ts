import MarkdownIt from "markdown-it";

// Only block maps are needed here; inline parsing belongs to each rendered block.
const markdownBlockParser = new MarkdownIt();
markdownBlockParser.core.ruler.disable("inline");

// The renderer decides what counts as a definition, so ask the same parser: a block
// that produces no tokens but registers references is nothing but definitions.
function isLinkReferenceDefinitionBlock(block: string): boolean {
  const env: { references?: Record<string, unknown> } = {};
  const tokens = markdownBlockParser.parse(block, env);
  return tokens.length === 0 && Object.keys(env.references ?? {}).length > 0;
}

/**
 * Definitions render nothing and resolve nothing on their own, so a block made only of
 * them would paint an empty row and break every reference that pointed at it. Fold it
 * into the block it belongs to: the one above, or the one below when it leads.
 */
function foldLinkReferenceDefinitions(blocks: string[]): string[] {
  const folded: string[] = [];
  let leading: string[] = [];
  for (const block of blocks) {
    if (isLinkReferenceDefinitionBlock(block)) {
      if (folded.length > 0) folded[folded.length - 1] += `\n\n${block}`;
      else leading.push(block);
      continue;
    }
    folded.push([...leading, block].join("\n\n"));
    leading = [];
  }
  if (leading.length > 0) folded.push(leading.join("\n\n"));
  return folded;
}

export interface MarkdownSelectionGroup {
  kind: "prose" | "other";
  text: string;
}

const PROSE_TOKEN_TYPES = new Set(["paragraph_open"]);

export function splitMarkdownBlocks(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const blocks: string[] = [];
  let currentLines: string[] = [];
  let sawBlockSeparator = false;
  const lines = text.split("\n");
  const structuralBlankLines = getStructuralBlankLines(text, lines);

  for (const [index, line] of lines.entries()) {
    const isBlankLine = line.trim().length === 0;

    if (isBlankLine && structuralBlankLines.has(index)) {
      currentLines.push(line);
      continue;
    }

    if (isBlankLine) {
      if (currentLines.length > 0) {
        sawBlockSeparator = true;
      }
      continue;
    }

    if (sawBlockSeparator) {
      blocks.push(currentLines.join("\n"));
      currentLines = [];
      sawBlockSeparator = false;
    }

    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    blocks.push(currentLines.join("\n"));
  }

  return foldLinkReferenceDefinitions(blocks.filter((block) => block.length > 0));
}

export function groupMarkdownForNativeSelection(text: string): MarkdownSelectionGroup[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split("\n");
  const groups: MarkdownSelectionGroup[] = [];
  let proseStart: number | null = null;
  let proseEnd = 0;
  let lineCursor = 0;
  const leadingDefinitions: string[] = [];

  function takeSlice(start: number, end: number): string | null {
    const grouped = lines.slice(start, end).join("\n");
    return grouped.trim().length > 0 ? grouped : null;
  }

  function withLeadingDefinitions(grouped: string): string {
    if (leadingDefinitions.length === 0) {
      return grouped;
    }
    const prefix = leadingDefinitions.join("\n\n");
    leadingDefinitions.length = 0;
    return `${prefix}\n\n${grouped}`;
  }

  // A reference definition emits no token, so the line range between tokens would
  // otherwise be dropped and the link it defines would stop resolving.
  function absorbDefinitionGap(nextLine: number) {
    if (nextLine < lineCursor) {
      return;
    }
    const gap = lines.slice(lineCursor, nextLine).join("\n");
    lineCursor = nextLine;
    if (!isLinkReferenceDefinitionBlock(gap)) {
      return;
    }
    if (proseStart !== null) {
      proseEnd = nextLine;
      return;
    }
    const definition = gap.trim();
    const last = groups[groups.length - 1];
    if (last) {
      last.text = `${last.text}\n\n${definition}`;
      return;
    }
    leadingDefinitions.push(definition);
  }

  function flushProse() {
    if (proseStart === null) {
      return;
    }
    const grouped = takeSlice(proseStart, proseEnd);
    proseStart = null;
    if (grouped) {
      groups.push({ kind: "prose", text: withLeadingDefinitions(grouped) });
    }
  }

  for (const token of markdownBlockParser.parse(text, {})) {
    if (token.level !== 0 || !token.map) {
      continue;
    }
    const [start, end] = token.map;
    absorbDefinitionGap(start);
    if (PROSE_TOKEN_TYPES.has(token.type)) {
      if (proseStart === null) {
        proseStart = start;
      }
      proseEnd = end;
      lineCursor = end;
      continue;
    }
    flushProse();
    const grouped = takeSlice(start, end);
    if (grouped) {
      groups.push({ kind: "other", text: withLeadingDefinitions(grouped) });
    }
    lineCursor = end;
  }

  absorbDefinitionGap(lines.length);
  flushProse();
  if (leadingDefinitions.length > 0) {
    groups.push({ kind: "prose", text: leadingDefinitions.join("\n\n") });
  }
  return groups;
}

function getStructuralBlankLines(text: string, lines: string[]): Set<number> {
  const blankLines = new Set<number>();
  for (const token of markdownBlockParser.parse(text, {})) {
    if (token.level !== 0 || !token.map) {
      continue;
    }
    const [start, end] = token.map;
    for (let index = start; index < end - 1; index += 1) {
      if (lines[index]?.trim().length === 0) {
        blankLines.add(index);
      }
    }
  }
  return blankLines;
}
