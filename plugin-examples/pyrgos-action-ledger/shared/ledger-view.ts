import { z } from "zod";

export const LEDGER_STATES = ["draft", "refined", "agreed", "dropped"] as const;

export const ActionItemSchema = z.object({
  id: z.string(),
  state: z.enum(LEDGER_STATES),
  item: z.string(),
  scope: z.string().nullable(),
  project: z.string().nullable(),
  doneCriteria: z.string().nullable(),
  transcriptRef: z.string().nullable(),
  launchError: z.string().nullable(),
  dropReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;
export type ActionState = (typeof LEDGER_STATES)[number];

export interface LedgerGroup {
  state: ActionState;
  title: string;
  items: ActionItem[];
}

const TITLES: Record<ActionState, string> = {
  draft: "Draft",
  refined: "Refined",
  agreed: "Agreed",
  dropped: "Dropped",
};

export function groupByState(items: readonly ActionItem[]): LedgerGroup[] {
  return LEDGER_STATES.map((state) => ({
    state,
    title: TITLES[state],
    items: items
      .filter((entry) => entry.state === state)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }));
}

export function parseLedgerRows(text: string): ActionItem[] {
  const latest = new Map<string, ActionItem>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = ActionItemSchema.safeParse(json);
    if (parsed.success) latest.set(parsed.data.id, parsed.data);
  }
  return [...latest.values()];
}

export function missingFields(entry: ActionItem): string[] {
  const missing: string[] = [];
  if (!entry.scope) missing.push("scope");
  if (!entry.project) missing.push("project");
  if (!entry.doneCriteria) missing.push("done-criteria");
  return missing;
}
