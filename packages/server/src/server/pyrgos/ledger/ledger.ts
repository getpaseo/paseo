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
  launchId: z.string().nullable().default(null),
  announcedAt: z.string().nullable().default(null),
  launchedAt: z.string().nullable().default(null),
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

export type LedgerErrorCode =
  | "not_found"
  | "bad_state"
  | "incomplete"
  | "empty"
  | "unconfirmed"
  | "duplicate";

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

const ANNOUNCE_FAILED = "announce failed: ";
const PERSIST_FAILED = "not recorded: ";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clean(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

export function createLedger(deps: LedgerDeps): Ledger {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const items = new Map<string, LedgerItem>();
  const inFlight = new Set<string>();
  const delivered = new Map<string, { announcedAt?: string; launchedAt?: string }>();
  for (const row of deps.store.load()) items.set(row.id, row);

  function save(next: LedgerItem): LedgerItem {
    deps.store.append(next);
    items.set(next.id, { ...next });
    return { ...next };
  }

  function copyItem(item: LedgerItem): LedgerItem {
    return { ...item };
  }

  function find(id: string): LedgerItem {
    const found = items.get(id);
    if (!found) throw new LedgerError("not_found", `no action item ${id}`, id);
    return found;
  }

  function get(id: string): LedgerItem {
    return { ...find(id) };
  }

  function editable(id: string): LedgerItem {
    const found = find(id);
    if (found.state === "agreed" || found.state === "dropped") {
      throw new LedgerError("bad_state", `item ${id} is ${found.state}`, id);
    }
    return found;
  }

  function propose(input: ProposeInput): LedgerItem {
    const text = clean(input.item);
    if (!text) throw new LedgerError("empty", "give an action item", null);
    const stamp = now().toISOString();
    const id = newId();
    if (items.has(id)) throw new LedgerError("duplicate", `action item ${id} already exists`, id);
    return save({
      id,
      state: "draft",
      item: text,
      scope: null,
      project: null,
      doneCriteria: null,
      transcriptRef: input.transcriptRef ?? null,
      launchError: null,
      launchId: null,
      announcedAt: null,
      launchedAt: null,
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

  // Runs one external step once. A step that ran but could not be persisted is remembered in
  // `done`, so a retry records it instead of running the effect again.
  async function runStep(
    item: LedgerItem,
    done: { announcedAt?: string; launchedAt?: string },
    field: "announcedAt" | "launchedAt",
    run: (item: LedgerItem) => Promise<void>,
    failed: (message: string) => string,
    errors: string[],
  ): Promise<LedgerItem> {
    if (item[field] !== null) return item;
    try {
      if (done[field] === undefined) {
        await run(item);
        done[field] = now().toISOString();
      }
      return save({ ...item, [field]: done[field] });
    } catch (error) {
      const message = errorMessage(error);
      errors.push(done[field] === undefined ? failed(message) : `${PERSIST_FAILED}${message}`);
      return item;
    }
  }

  async function agree(id: string, input: AgreeInput): Promise<LedgerItem> {
    if (input?.confirmed !== true) {
      throw new LedgerError("unconfirmed", `item ${id} needs explicit confirmation`, id);
    }
    const current = get(id);
    const outstanding = (item: LedgerItem) =>
      (deps.announce !== undefined && item.announcedAt === null) ||
      (deps.launch !== undefined && item.launchedAt === null);
    const retry = current.state === "agreed" && outstanding(current);
    if (current.state !== "refined" && !retry) {
      throw new LedgerError("bad_state", `item ${id} is ${current.state}, not refined`, id);
    }
    if (inFlight.has(id)) {
      throw new LedgerError("bad_state", `item ${id} is already being agreed`, id);
    }
    const missing = MISSING_FIELDS.filter((field) => current[field] === null);
    if (missing.length > 0) {
      throw new LedgerError("incomplete", `item ${id} is missing ${missing.join(", ")}`, id);
    }
    inFlight.add(id);
    try {
      let agreed = retry
        ? current
        : save({
            ...current,
            state: "agreed",
            launchId: newId(),
            updatedAt: now().toISOString(),
          });
      const errors: string[] = [];
      const done = delivered.get(id) ?? {};
      delivered.set(id, done);
      const announce = deps.announce;
      if (announce) {
        agreed = await runStep(
          agreed,
          done,
          "announcedAt",
          announce,
          (m) => `${ANNOUNCE_FAILED}${m}`,
          errors,
        );
      }
      const launch = deps.launch;
      if (launch) agreed = await runStep(agreed, done, "launchedAt", launch, (m) => m, errors);
      const launchError = errors.length > 0 ? errors.join("; ") : null;
      if (launchError === agreed.launchError) return agreed;
      return save({ ...agreed, launchError, updatedAt: now().toISOString() });
    } finally {
      inFlight.delete(id);
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
    return Array.from(items.values(), copyItem);
  }

  return { propose, refine, agree, drop, get, list };
}
