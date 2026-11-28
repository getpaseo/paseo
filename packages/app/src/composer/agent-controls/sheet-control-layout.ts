import type { ComposerControlItem } from "./composer-control";

/**
 * How a control draws on the agent settings sheet's home page. Everything a phone can set in one
 * tap stays on the page; only a list too long or too open-ended to scan moves to a page of its own.
 */
export type SheetControlLayout = "switch" | "action" | "pills" | "radioList" | "subpage";

type SelectItem = Extract<ComposerControlItem, { type: "select" }>;

/** More choices than this read as a list to search, not a set to scan. */
const MAX_INLINE_CHOICES = 7;
/** A longer label wraps a pill row into a ragged block; a list reads better. */
const MAX_PILL_LABEL_LENGTH = 12;

export function classifySheetControl(control: ComposerControlItem): SheetControlLayout {
  if (control.type === "toggle") return "switch";
  if (control.type === "action") return "action";
  if (control.searchable || control.remoteSearch || control.choices.length > MAX_INLINE_CHOICES) {
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
    if (item.type === "select" && (layout === "pills" || layout === "radioList")) {
      inline.push({ kind: layout, item });
    } else if (layout !== "pills" && layout !== "radioList") {
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
