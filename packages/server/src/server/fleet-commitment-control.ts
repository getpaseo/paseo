import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FLEET_CONTROL_CONTRACT_VERSION,
  FLEET_CONTROL_PORTFOLIO_AGENT_ID,
  FleetControlMarkerSchema,
  FleetControlReceiptSchema,
  type FleetControlAction,
  type FleetControlMarker,
  type FleetControlReceipt,
  type FleetControlStrictResult,
} from "@getpaseo/protocol/fleet-control";
import { writeFileAtomic } from "./atomic-file.js";

export type FleetControlCrashPoint =
  | "before_ledger_write"
  | "after_ledger_write_before_strict_result"
  | "after_strict_result_before_confirmation"
  | "after_confirmation_persistence";

export class FleetControlError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "FleetControlError";
  }
}

interface FleetControlAgentRecord {
  id: string;
  archivedAt?: string | null;
}

interface FleetControlOptions {
  ledgerPath: string;
  receiptsDirectory: string;
  readPortfolioAgent: () => Promise<FleetControlAgentRecord | null>;
  streamAgent: (
    agentId: string,
    prompt: string,
  ) => AsyncGenerator<{ type: string; turnId?: string }>;
  crash?: (point: FleetControlCrashPoint) => void | Promise<void>;
}

interface OperateInput {
  requestId: string;
  operationRequestId: string;
  commitmentId: string;
  action: FleetControlAction;
  expectedPriorDigest: string;
  expectedPortfolioAgentId: string;
  principalId: string;
}

interface ConfirmInput {
  requestId: string;
  operationRequestId: string;
  commitmentId: string;
  principalId: string;
}

interface LedgerControl {
  marker: FleetControlMarker;
  digest: string;
}

export function fleetControlDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function receiptFingerprint(input: OperateInput): string {
  return fleetControlDigest([
    FLEET_CONTROL_CONTRACT_VERSION,
    input.operationRequestId,
    input.commitmentId,
    input.action,
    input.expectedPriorDigest,
    input.expectedPortfolioAgentId,
  ]);
}

function receiptIdentity(operationRequestId: string): string {
  return `fleet-control-${fleetControlDigest([FLEET_CONTROL_CONTRACT_VERSION, operationRequestId])}`;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function splitMarkdownRow(line: string): string[] | null {
  if (!line.trimStart().startsWith("|")) return null;
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of line.slice(line.indexOf("|") + 1)) {
    if (character === "|" && !escaped) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  if (cell.trim().length > 0) return null;
  return cells;
}

const MARKER_PATTERN = /<!--(\[[^\r\n]*\])-->/u;

function findControl(
  contents: string,
  commitmentId: string,
): {
  lines: string[];
  lineIndex: number;
  markerText: string;
  control: LedgerControl;
} {
  const lines = contents.split("\n");
  let found:
    | {
        lines: string[];
        lineIndex: number;
        markerText: string;
        control: LedgerControl;
      }
    | undefined;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const cells = splitMarkdownRow(line);
    if (!cells || cells.length !== 7 || cells[0]!.trim() !== commitmentId) continue;
    if (found) throw new FleetControlError("commitment_duplicate");
    const match = cells[6]!.match(MARKER_PATTERN);
    if (!match?.[1] || cells[6]!.slice(0, match.index).trim())
      throw new FleetControlError("control_marker_missing");
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      throw new FleetControlError("control_marker_invalid");
    }
    const result = FleetControlMarkerSchema.safeParse(parsed);
    if (!result.success || result.data[1] !== commitmentId)
      throw new FleetControlError("control_marker_invalid");
    found = {
      lines,
      lineIndex,
      markerText: match[0],
      control: { marker: result.data, digest: fleetControlDigest(result.data) },
    };
  }
  if (found) return found;
  throw new FleetControlError("commitment_not_found");
}

export class FleetCommitmentControlService {
  private operations: Promise<void> = Promise.resolve();
  private readonly active = new Map<
    string,
    { fingerprint: string; operation: Promise<FleetControlReceipt> }
  >();

  constructor(private readonly options: FleetControlOptions) {
    if (!options.ledgerPath || !options.receiptsDirectory)
      throw new Error("Fleet commitment control paths are required");
  }

  operate(input: OperateInput): Promise<FleetControlReceipt> {
    this.requireDeckPrincipal(input.principalId);
    const fingerprint = receiptFingerprint(input);
    const active = this.active.get(input.operationRequestId);
    if (active) {
      if (active.fingerprint !== fingerprint)
        throw new FleetControlError("operation_request_conflict");
      return active.operation;
    }
    const operation = this.exclusive(() => this.operateExclusive(input));
    this.active.set(input.operationRequestId, { fingerprint, operation });
    void operation.finally(() => this.active.delete(input.operationRequestId)).catch(() => {});
    return operation;
  }

  async read(input: { commitmentId: string; principalId: string }): Promise<LedgerControl> {
    this.requireDeckPrincipal(input.principalId);
    return this.exclusive(() => this.readLedger(input.commitmentId));
  }

  async confirm(input: ConfirmInput): Promise<FleetControlReceipt> {
    this.requireDeckPrincipal(input.principalId);
    return await this.exclusive(async () => {
      const receipt = await this.requireReceipt(input.operationRequestId);
      if (receipt.commitmentId !== input.commitmentId)
        throw new FleetControlError("operation_request_conflict");
      if (receipt.lifecycle === "completed") return receipt;
      if (receipt.lifecycle !== "awaiting_confirmation" || !receipt.strictResult) return receipt;
      const current = await this.readLedger(input.commitmentId);
      const strict = receipt.strictResult;
      if (
        current.digest !== strict.afterDigest ||
        JSON.stringify(current.marker) !== JSON.stringify(strict.after)
      ) {
        return this.finish(receipt, "failed", "confirmation_mismatch");
      }
      const completed = await this.finish(receipt, "completed");
      await this.options.crash?.("after_confirmation_persistence");
      return completed;
    });
  }

  // The crash-safe transaction stays linear so every durable boundary remains visible in order.
  // eslint-disable-next-line complexity
  private async operateExclusive(input: OperateInput): Promise<FleetControlReceipt> {
    const fingerprint = receiptFingerprint(input);
    const existing = await this.readReceipt(input.operationRequestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new FleetControlError("operation_request_conflict");
      if (existing.lifecycle !== "executing") return existing;
      return this.finish(
        existing,
        existing.ledgerWriteStarted ? "outcome_unknown" : "failed",
        existing.ledgerWriteStarted ? "ledger_write_outcome_unknown" : "execution_interrupted",
      );
    }

    let receipt: FleetControlReceipt = {
      contractVersion: FLEET_CONTROL_CONTRACT_VERSION,
      operationRequestId: input.operationRequestId,
      commitmentId: input.commitmentId,
      action: input.action,
      expectedPriorDigest: input.expectedPriorDigest,
      expectedPortfolioAgentId: input.expectedPortfolioAgentId,
      fingerprint,
      lifecycle: "executing",
      ledgerWriteStarted: false,
    };
    await this.writeReceipt(receipt);

    if (input.expectedPortfolioAgentId !== FLEET_CONTROL_PORTFOLIO_AGENT_ID)
      return this.finish(receipt, "rejected", "portfolio_identity_mismatch");
    const agent = await this.options.readPortfolioAgent();
    if (!agent) return this.finish(receipt, "rejected", "portfolio_agent_missing");
    if (agent.id !== FLEET_CONTROL_PORTFOLIO_AGENT_ID)
      return this.finish(receipt, "rejected", "portfolio_identity_mismatch");
    if (agent.archivedAt) return this.finish(receipt, "rejected", "portfolio_agent_archived");

    let before: LedgerControl;
    try {
      before = await this.readLedger(input.commitmentId);
    } catch (error) {
      return this.rejectLedgerError(receipt, error);
    }
    if (before.marker[5] !== FLEET_CONTROL_PORTFOLIO_AGENT_ID)
      return this.finish(receipt, "rejected", "portfolio_custody_changed");
    if (before.digest !== input.expectedPriorDigest)
      return this.finish(receipt, "rejected", "stale_control");
    if (before.marker[3] === Number.MAX_SAFE_INTEGER)
      return this.finish(receipt, "rejected", "revision_exhausted");

    let stream: AsyncGenerator<{ type: string; turnId?: string }>;
    try {
      stream = this.options.streamAgent(
        FLEET_CONTROL_PORTFOLIO_AGENT_ID,
        `Apply Fleet commitment ${input.action} for ${input.commitmentId} under operation ${input.operationRequestId}.`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("active run"))
        return this.finish(receipt, "rejected", "agent_busy");
      return this.finish(receipt, "failed", "agent_start_failed");
    }
    let first: IteratorResult<{ type: string; turnId?: string }>;
    try {
      first = await stream.next();
    } catch {
      return this.finish(receipt, "failed", "agent_start_failed");
    }
    if (first.done || first.value.type !== "turn_started" || !first.value.turnId) {
      void stream.return(undefined).catch(() => {});
      return this.finish(receipt, "failed", "agent_start_failed");
    }
    receipt = {
      ...receipt,
      admittedRun: { agentId: FLEET_CONTROL_PORTFOLIO_AGENT_ID, turnId: first.value.turnId },
    };
    await this.writeReceipt(receipt);
    void (async () => {
      try {
        while (!(await stream.next()).done) {}
      } catch {
        // The admitted turn is audit context. Its output cannot change the durable control result.
      }
    })();
    await this.options.crash?.("before_ledger_write");

    const currentAgent = await this.options.readPortfolioAgent();
    if (
      !currentAgent ||
      currentAgent.id !== FLEET_CONTROL_PORTFOLIO_AGENT_ID ||
      currentAgent.archivedAt
    ) {
      return this.finish(receipt, "rejected", "portfolio_custody_changed");
    }

    const state = input.action === "pause" ? "paused" : "open";
    const after: FleetControlMarker = [
      FLEET_CONTROL_CONTRACT_VERSION,
      input.commitmentId,
      state,
      before.marker[3] + 1,
      input.operationRequestId,
      FLEET_CONTROL_PORTFOLIO_AGENT_ID,
    ];
    let written: LedgerControl;
    try {
      written = await this.writeLedger(input.commitmentId, before.digest, after, async () => {
        receipt = { ...receipt, ledgerWriteStarted: true };
        await this.writeReceipt(receipt);
      });
    } catch (error) {
      return this.rejectLedgerError(receipt, error);
    }
    await this.options.crash?.("after_ledger_write_before_strict_result");

    const strictResult: FleetControlStrictResult = {
      contractVersion: FLEET_CONTROL_CONTRACT_VERSION,
      operationRequestId: input.operationRequestId,
      commitmentId: input.commitmentId,
      action: input.action,
      portfolioAgentId: FLEET_CONTROL_PORTFOLIO_AGENT_ID,
      before: before.marker,
      after: written.marker,
      beforeDigest: before.digest,
      afterDigest: written.digest,
      revision: written.marker[3],
      changed: before.marker[2] !== written.marker[2],
      admittedRun: receipt.admittedRun!,
    };
    receipt = { ...receipt, lifecycle: "awaiting_confirmation", strictResult };
    await this.writeReceipt(receipt);
    await this.options.crash?.("after_strict_result_before_confirmation");
    return receipt;
  }

  private async readLedger(commitmentId: string): Promise<LedgerControl> {
    const contents = await readFile(this.options.ledgerPath, "utf8");
    return findControl(contents, commitmentId).control;
  }

  private async writeLedger(
    commitmentId: string,
    expectedDigest: string,
    marker: FleetControlMarker,
    beforeRename: () => Promise<void>,
  ): Promise<LedgerControl> {
    const contents = await readFile(this.options.ledgerPath, "utf8");
    const found = findControl(contents, commitmentId);
    if (found.control.digest !== expectedDigest) throw new FleetControlError("stale_control");
    const markerText = `<!--${JSON.stringify(marker)}-->`;
    found.lines[found.lineIndex] = found.lines[found.lineIndex]!.replace(
      found.markerText,
      markerText,
    );
    await beforeRename();
    await writeFileAtomic(this.options.ledgerPath, found.lines.join("\n"));
    return { marker, digest: fleetControlDigest(marker) };
  }

  private rejectLedgerError(
    receipt: FleetControlReceipt,
    error: unknown,
  ): Promise<FleetControlReceipt> {
    const code = error instanceof FleetControlError ? error.code : "ledger_failed";
    const lifecycle = receipt.ledgerWriteStarted ? "outcome_unknown" : "rejected";
    return this.finish(receipt, lifecycle, code);
  }

  private async finish(
    receipt: FleetControlReceipt,
    lifecycle: FleetControlReceipt["lifecycle"],
    code?: string,
  ): Promise<FleetControlReceipt> {
    const next = { ...receipt, lifecycle, ...(code ? { code } : {}) };
    await this.writeReceipt(next);
    return next;
  }

  private requireDeckPrincipal(principalId: string): void {
    if (principalId !== "service:firstmate-deck")
      throw new FleetControlError("confirmation_access_denied");
  }

  private receiptPath(operationRequestId: string): string {
    return join(this.options.receiptsDirectory, `${receiptIdentity(operationRequestId)}.json`);
  }

  private async requireReceipt(operationRequestId: string): Promise<FleetControlReceipt> {
    const receipt = await this.readReceipt(operationRequestId);
    if (!receipt) throw new FleetControlError("operation_not_found");
    return receipt;
  }

  private async readReceipt(operationRequestId: string): Promise<FleetControlReceipt | null> {
    const text = await readOptional(this.receiptPath(operationRequestId));
    return text === null ? null : FleetControlReceiptSchema.parse(JSON.parse(text));
  }

  private async writeReceipt(receipt: FleetControlReceipt): Promise<void> {
    await mkdir(this.options.receiptsDirectory, { recursive: true });
    await writeFileAtomic(this.receiptPath(receipt.operationRequestId), JSON.stringify(receipt));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operations;
    let release!: () => void;
    this.operations = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
