import type { ComposerControlChoice, ComposerControlItem } from "./composer-control";

/**
 * How a control draws on the agent settings sheet's home page. Everything a phone can set in one
 * tap stays on the page; only a list too long or too open-ended to scan moves to a page of its own.
 */
export type SheetControlLayout = "switch" | "action" | "slider" | "pills" | "radioList" | "subpage";

type SelectItem = Extract<ComposerControlItem, { type: "select" }>;

/** More choices than this read as a list to search, not a set to scan. */
const MAX_INLINE_CHOICES = 7;
/** A longer label wraps a pill row into a ragged block; a list reads better. */
const MAX_PILL_LABEL_LENGTH = 12;
/** Ordered thinking scales can span up to 8 stops (e.g. Auto, Off, Minimal..Max). */
const MIN_SLIDER_CHOICES = 3;
const MAX_SLIDER_CHOICES = 8;

const THINKING_LEVEL_RANKS: Readonly<Record<string, number>> = {
  auto: 0,
  none: 1,
  off: 1,
  disabled: 1,
  minimal: 2,
  min: 2,
  light: 2,
  low: 3,
  medium: 4,
  med: 4,
  balanced: 4,
  normal: 4,
  default: 4,
  high: 5,
  deep: 5,
  xhigh: 6,
  extrahigh: 6,
  veryhigh: 6,
  max: 7,
  maximum: 7,
  extreme: 7,
  ultra: 7,
};

const NUMERIC_BUDGET_PATTERN = /^(\d+(?:\.\d+)?)(k|m)?$/;

function normalizeRankToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function resolveEffortRank(choice: ComposerControlChoice): number | null {
  return (
    THINKING_LEVEL_RANKS[normalizeRankToken(choice.value)] ??
    THINKING_LEVEL_RANKS[normalizeRankToken(choice.label)] ??
    null
  );
}

function resolveNumericBudget(raw: string): number | null {
  const token = normalizeRankToken(raw)
    .replace(/tokens?$/i, "")
    .replace(/,/g, "");
  if (token === "off" || token === "none" || token === "disabled") return 0;
  const match = NUMERIC_BUDGET_PATTERN.exec(token);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  if (match[2] === "k") return base * 1_000;
  if (match[2] === "m") return base * 1_000_000;
  return base;
}

function isStrictlyIncreasing(values: readonly (number | null)[]): boolean {
  let prev = -Infinity;
  for (const value of values) {
    if (value === null || value <= prev) return false;
    prev = value;
  }
  return true;
}

/** True when a thinking select's choices form a recognized, strictly increasing scale. */
export function isOrderedThinkingRange(choices: readonly ComposerControlChoice[]): boolean {
  if (choices.length < MIN_SLIDER_CHOICES || choices.length > MAX_SLIDER_CHOICES) return false;
  if (choices.some((choice) => Boolean(choice.description))) return false;
  if (isStrictlyIncreasing(choices.map(resolveEffortRank))) return true;
  return isStrictlyIncreasing(
    choices.map(
      (choice) => resolveNumericBudget(choice.value) ?? resolveNumericBudget(choice.label),
    ),
  );
}

export function classifySheetControl(control: ComposerControlItem): SheetControlLayout {
  if (control.type === "toggle") return "switch";
  if (control.type === "action") return "action";
  if (control.searchable || control.remoteSearch) {
    return "subpage";
  }
  if (control.id === "thinking" && isOrderedThinkingRange(control.choices)) {
    return "slider";
  }
  if (control.choices.length > MAX_INLINE_CHOICES) {
    return "subpage";
  }
  const fitsPills = control.choices.every(
    (choice) => !choice.description && choice.label.length <= MAX_PILL_LABEL_LENGTH,
  );
  return fitsPills ? "pills" : "radioList";
}

export interface SheetHomeRow {
  layout: Extract<SheetControlLayout, "switch" | "action" | "subpage">;
  item: ComposerControlItem;
}

export type SheetHomeBlock =
  | { kind: "slider"; item: SelectItem }
  | { kind: "pills"; item: SelectItem }
  | { kind: "radioList"; item: SelectItem }
  | { kind: "rows"; rows: SheetHomeRow[] }
  | { kind: "mode"; layout: "radioList" | "subpage" };

/**
 * The home page, top to bottom: thinking, the selects that fit inline, one card holding every
 * switch, action and row that opens a page, then mode. Mode is a list with icons, so it never
 * becomes pills.
 */
export function layoutSheetHome(input: {
  thinkingItems: readonly ComposerControlItem[];
  featureItems: readonly ComposerControlItem[];
  /** 0 when the agent has no modes. */
  modeChoiceCount: number;
}): SheetHomeBlock[] {
  const inline: SheetHomeBlock[] = [];
  const rows: SheetHomeRow[] = [];
  for (const item of [...input.thinkingItems, ...input.featureItems]) {
    const layout = classifySheetControl(item);
    if (
      item.type === "select" &&
      (layout === "slider" || layout === "pills" || layout === "radioList")
    ) {
      inline.push({ kind: layout, item });
    } else if (layout !== "slider" && layout !== "pills" && layout !== "radioList") {
      rows.push({ layout, item });
    }
  }
  const blocks: SheetHomeBlock[] = [...inline];
  if (rows.length > 0) blocks.push({ kind: "rows", rows });
  if (input.modeChoiceCount > 0) {
    blocks.push({
      kind: "mode",
      layout: input.modeChoiceCount > MAX_INLINE_CHOICES ? "subpage" : "radioList",
    });
  }
  return blocks;
}
