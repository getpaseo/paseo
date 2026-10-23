import { randomUUID } from "node:crypto";
import { z } from "zod";

export const LEDGER_STATES = ["draft", "refined", "agreed", "dropped"] as const;
export type LedgerState = (typeof LEDGER_STATES)[number];

export const LedgerItemSchema = z.object({
  id: z.string().min(1),
  state: z.enum(LEDGER_STATES),
  item: z.string().min(1),
  scope: z.string().nullable(),
  project: z.string().nullable(),
  doneCriteria: z.string().nullable(),
  transcriptRef: z.string().nullable(),
  launchError: z.string().nullable(),
  dropReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LedgerItem = z.infer<typeof LedgerItemSchema>;

export interface ProposeInput {
  item: string;
  transcriptRef?: string;
}

export interface RefineInput {
  item?: string;
  scope?: string;
  project?: string;
  doneCriteria?: string;
}

export interface AgreeInput {
  confirmed: true;
}

export interface LedgerStore {
  append(item: LedgerItem): void;
  load(): LedgerItem[];
}

export interface LedgerDeps {
  store: LedgerStore;
  now?: () => Date;
  newId?: () => string;
  announce?: (item: LedgerItem) => Promise<void>;
  launch?: (item: LedgerItem) => Promise<void>;
}

export type LedgerErrorCode = "not_found" | "bad_state" | "incomplete" | "empty";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly id: string | null,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface Ledger {
  propose(input: ProposeInput): LedgerItem;
  refine(id: string, input: RefineInput): LedgerItem;
  agree(id: string, input: AgreeInput): Promise<LedgerItem>;
  drop(id: string, reason?: string): LedgerItem;
  get(id: string): LedgerItem;
  list(): LedgerItem[];
}

const MISSING_FIELDS = ["scope", "project", "doneCriteria"] as const;

function clean(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

export function createLedger(deps: LedgerDeps): Ledger {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID().slice(0, 8));
  const items = new Map<string, LedgerItem>();
  for (const row of deps.store.load()) items.set(row.id, row);

  function save(next: LedgerItem): LedgerItem {
    items.set(next.id, next);
    deps.store.append(next);
    return next;
  }

  function get(id: string): LedgerItem {
    const found = items.get(id);
    if (!found) throw new LedgerError("not_found", `no action item ${id}`, id);
    return found;
  }

  function editable(id: string): LedgerItem {
    const found = get(id);
    if (found.state === "agreed" || found.state === "dropped") {
      throw new LedgerError("bad_state", `item ${id} is ${found.state}`, id);
    }
    return found;
  }

  function propose(input: ProposeInput): LedgerItem {
    const text = clean(input.item);
    if (!text) throw new LedgerError("empty", "give an action item", null);
    const stamp = now().toISOString();
    return save({
      id: newId(),
      state: "draft",
      item: text,
      scope: null,
      project: null,
      doneCriteria: null,
      transcriptRef: input.transcriptRef ?? null,
      launchError: null,
      dropReason: null,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }

  function refine(id: string, input: RefineInput): LedgerItem {
    const current = editable(id);
    const text = input.item === undefined ? current.item : clean(input.item);
    if (!text) throw new LedgerError("empty", "give an action item", id);
    return save({
      ...current,
      state: "refined",
      item: text,
      scope: input.scope === undefined ? current.scope : clean(input.scope) || null,
      project: input.project === undefined ? current.project : clean(input.project) || null,
      doneCriteria:
        input.doneCriteria === undefined ? current.doneCriteria : clean(input.doneCriteria) || null,
      updatedAt: now().toISOString(),
    });
  }

  async function agree(id: string, _input: AgreeInput): Promise<LedgerItem> {
    const current = get(id);
    if (current.state !== "refined") {
      throw new LedgerError("bad_state", `item ${id} is ${current.state}, not refined`, id);
    }
    const missing = MISSING_FIELDS.filter((field) => current[field] === null);
    if (missing.length > 0) {
      throw new LedgerError("incomplete", `item ${id} is missing ${missing.join(", ")}`, id);
    }
    const agreed = save({ ...current, state: "agreed", updatedAt: now().toISOString() });
    await deps.announce?.(agreed);
    if (!deps.launch) return agreed;
    try {
      await deps.launch(agreed);
      return agreed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return save({ ...agreed, launchError: message, updatedAt: now().toISOString() });
    }
  }

  function drop(id: string, reason?: string): LedgerItem {
    const current = editable(id);
    return save({
      ...current,
      state: "dropped",
      dropReason: reason ? clean(reason) : null,
      updatedAt: now().toISOString(),
    });
  }

  function list(): LedgerItem[] {
    return [...items.values()];
  }

  return { propose, refine, agree, drop, get, list };
}
