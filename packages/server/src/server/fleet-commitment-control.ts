import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  FLEET_CONTROL_CONTRACT_VERSION,
  FLEET_CONTROL_PORTFOLIO_AGENT_ID,
  FleetControlMarkerSchema,
  type FleetControlAction,
  type FleetControlMarker,
  type FleetControlReceipt,
  type FleetControlStrictResult,
} from "@getpaseo/protocol/fleet-control";
import { withExclusiveFileLock, writeFileAtomic } from "./atomic-file.js";
import type { MessageReceipts } from "./message-receipts/index.js";

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
  receipts: Pick<
    MessageReceipts,
    "readFleetControlReceipt" | "writeFleetControlReceipt" | "withFleetControlOperation"
  >;
  readPortfolioAgent: () => Promise<FleetControlAgentRecord | null>;
  streamAgent: (
    agentId: string,
    prompt: string,
    options: { requireIdle: true },
  ) => AsyncGenerator<{ type: string; turnId?: string }>;
  crash?: (point: FleetControlCrashPoint) => void | Promise<void>;
  beforeLedgerRename?: () => void | Promise<void>;
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

interface MarkdownCell {
  value: string;
  start: number;
}

function splitMarkdownRow(line: string): MarkdownCell[] | null {
  if (!line.trimStart().startsWith("|")) return null;
  const cells: MarkdownCell[] = [];
  let cellStart = line.indexOf("|") + 1;
  let escaped = false;
  for (let index = cellStart; index < line.length; index++) {
    const character = line[index]!;
    if (character === "|" && !escaped) {
      cells.push({ value: line.slice(cellStart, index), start: cellStart });
      cellStart = index + 1;
    }
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  if (line.slice(cellStart).trim().length > 0) return null;
  return cells;
}

const MARKER_PATTERN = /<!--(\[[^\r\n]*?\])-->/gu;

function parseControlRow(
  line: string,
  expectedCommitmentId?: string,
): { markerStart: number; markerEnd: number; control: LedgerControl } {
  const cells = splitMarkdownRow(line);
  if (!cells || cells.length !== 7) throw new FleetControlError("control_marker_invalid");
  const remainingCell = cells[6]!;
  const matches = [...remainingCell.value.matchAll(MARKER_PATTERN)];
  if (matches.length !== 1 || !matches[0]?.[0] || !matches[0][1]) {
    throw new FleetControlError("control_marker_invalid");
  }
  const match = matches[0];
  if (remainingCell.value.slice(0, match.index).trim()) {
    throw new FleetControlError("control_marker_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw new FleetControlError("control_marker_invalid");
  }
  const result = FleetControlMarkerSchema.safeParse(parsed);
  if (
    !result.success ||
    JSON.stringify(result.data) !== match[1] ||
    cells[0]!.value.trim() !== result.data[1] ||
    (expectedCommitmentId !== undefined && result.data[1] !== expectedCommitmentId)
  ) {
    throw new FleetControlError("control_marker_invalid");
  }
  const markerStart = remainingCell.start + (match.index ?? 0);
  return {
    markerStart,
    markerEnd: markerStart + match[0].length,
    control: { marker: result.data, digest: fleetControlDigest(result.data) },
  };
}

function findControl(
  contents: string,
  commitmentId: string,
): {
  markerStart: number;
  markerEnd: number;
  control: LedgerControl;
} {
  const lines = contents.split("\n");
  let found:
    | {
        markerStart: number;
        markerEnd: number;
        control: LedgerControl;
      }
    | undefined;
  let lineStart = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const cells = splitMarkdownRow(line);
    if (!cells || cells.length !== 7 || cells[0]!.value.trim() !== commitmentId) {
      lineStart += line.length + 1;
      continue;
    }
    if (found) throw new FleetControlError("commitment_duplicate");
    if (!cells[6]!.value.includes("<!--")) throw new FleetControlError("control_marker_missing");
    const parsed = parseControlRow(line, commitmentId);
    found = {
      markerStart: lineStart + parsed.markerStart,
      markerEnd: lineStart + parsed.markerEnd,
      control: parsed.control,
    };
    lineStart += line.length + 1;
  }
  if (found) return found;
  throw new FleetControlError("commitment_not_found");
}

export function resolveReadyFleetCommitmentLedgerPath(ledgerPath: string): string {
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(ledgerPath);
    if (!statSync(resolvedPath).isFile()) {
      throw new Error("not a regular file");
    }
    const contents = readFileSync(resolvedPath, "utf8");
    const commitmentIds = new Set<string>();
    let markerCount = 0;
    for (const line of contents.split("\n")) {
      if (!line.includes("<!--") || !line.includes(FLEET_CONTROL_CONTRACT_VERSION)) continue;
      const { control } = parseControlRow(line);
      if (commitmentIds.has(control.marker[1])) {
        throw new FleetControlError("commitment_duplicate");
      }
      commitmentIds.add(control.marker[1]);
      markerCount++;
    }
    if (markerCount === 0) throw new Error("missing control marker");
  } catch (error) {
    throw new Error(`Fleet commitment ledger is not ready: ${String(error)}`, { cause: error });
  }
  return resolvedPath;
}

export class FleetCommitmentControlService {
  private readonly active = new Map<
    string,
    { fingerprint: string; operation: Promise<FleetControlReceipt> }
  >();

  constructor(private readonly options: FleetControlOptions) {
    if (!options.ledgerPath || !options.receipts)
      throw new Error("Fleet commitment control paths are required");
    this.options.ledgerPath = resolveReadyFleetCommitmentLedgerPath(options.ledgerPath);
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
    const operation = this.options.receipts.withFleetControlOperation(
      input.operationRequestId,
      () => this.operateExclusive(input),
    );
    this.active.set(input.operationRequestId, { fingerprint, operation });
    void operation.finally(() => this.active.delete(input.operationRequestId)).catch(() => {});
    return operation;
  }

  async read(input: { commitmentId: string; principalId: string }): Promise<LedgerControl> {
    this.requireDeckPrincipal(input.principalId);
    return this.readLedger(input.commitmentId);
  }

  async confirm(input: ConfirmInput): Promise<FleetControlReceipt> {
    this.requireDeckPrincipal(input.principalId);
    return await this.options.receipts.withFleetControlOperation(
      input.operationRequestId,
      async () => {
        const receipt = await this.requireReceipt(input.operationRequestId);
        if (receipt.commitmentId !== input.commitmentId)
          throw new FleetControlError("operation_request_conflict");
        if (receipt.lifecycle === "completed") return receipt;
        if (receipt.lifecycle !== "awaiting_confirmation" || !receipt.strictResult) return receipt;
        const identityError = await this.currentPortfolioIdentityError();
        if (identityError) return this.finish(receipt, "rejected", identityError);
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
      },
    );
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
    const identityError = await this.currentPortfolioIdentityError();
    if (identityError) return this.finish(receipt, "rejected", identityError);

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
        { requireIdle: true },
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("active run") || error.message.includes("not idle (running)"))
          return this.finish(receipt, "rejected", "agent_busy");
        if (error.message.includes("not idle (error)"))
          return this.finish(receipt, "rejected", "portfolio_agent_error");
        if (error.message.includes("not idle (initializing)"))
          return this.finish(receipt, "rejected", "portfolio_agent_initializing");
        if (error.message.includes("Unknown agent"))
          return this.finish(receipt, "rejected", "portfolio_agent_missing");
        if (error.message.includes("no managed session"))
          return this.finish(receipt, "rejected", "portfolio_agent_archived");
      }
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

    const currentIdentityError = await this.currentPortfolioIdentityError();
    if (currentIdentityError) return this.finish(receipt, "rejected", currentIdentityError);

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
    // Every trusted canonical-ledger writer must hold this adjacent lock. Writes
    // outside that contract can only be rejected when the content CAS observes them.
    return withExclusiveFileLock(`${this.options.ledgerPath}.fleet-control.lock`, async () => {
      await this.options.beforeLedgerRename?.();
      const admittedContents = await readFile(this.options.ledgerPath, "utf8");
      const admitted = findControl(admittedContents, commitmentId);
      if (admitted.control.digest !== expectedDigest) throw new FleetControlError("stale_control");

      await beforeRename();
      const currentContents = await readFile(this.options.ledgerPath, "utf8");
      if (currentContents !== admittedContents) throw new Error("atomic_file_source_changed");
      const currentStat = await stat(this.options.ledgerPath);
      const current = findControl(currentContents, commitmentId);
      if (current.control.digest !== expectedDigest) throw new FleetControlError("stale_control");
      const markerText = `<!--${JSON.stringify(marker)}-->`;
      const nextContents =
        currentContents.slice(0, current.markerStart) +
        markerText +
        currentContents.slice(current.markerEnd);
      await writeFileAtomic(this.options.ledgerPath, nextContents, {
        expectedSource: currentContents,
        expectedSourceStat: currentStat,
        preserveSourceMetadata: true,
      });
      return { marker, digest: fleetControlDigest(marker) };
    });
  }

  private rejectLedgerError(
    receipt: FleetControlReceipt,
    error: unknown,
  ): Promise<FleetControlReceipt> {
    let code = "ledger_failed";
    if (error instanceof FleetControlError) code = error.code;
    else if (
      error instanceof Error &&
      (error.message.startsWith("file_lock_") || error.message === "atomic_file_source_changed")
    ) {
      code = error.message;
    }
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

  private async currentPortfolioIdentityError(): Promise<string | null> {
    const agent = await this.options.readPortfolioAgent();
    if (!agent) return "portfolio_agent_missing";
    if (agent.id !== FLEET_CONTROL_PORTFOLIO_AGENT_ID) return "portfolio_identity_mismatch";
    if (agent.archivedAt) return "portfolio_agent_archived";
    return null;
  }

  private async requireReceipt(operationRequestId: string): Promise<FleetControlReceipt> {
    const receipt = await this.readReceipt(operationRequestId);
    if (!receipt) throw new FleetControlError("operation_not_found");
    return receipt;
  }

  private async readReceipt(operationRequestId: string): Promise<FleetControlReceipt | null> {
    return this.options.receipts.readFleetControlReceipt(operationRequestId);
  }

  private async writeReceipt(receipt: FleetControlReceipt): Promise<void> {
    await this.options.receipts.writeFleetControlReceipt(receipt);
  }
}
