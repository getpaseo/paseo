import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FLEET_CONTROL_PORTFOLIO_AGENT_ID,
  type FleetControlAction,
} from "@getpaseo/protocol/fleet-control";
import {
  FleetCommitmentControlService,
  fleetControlDigest,
  type FleetControlCrashPoint,
} from "./fleet-commitment-control.js";

const commitmentId = "64e89b9a-ff01-4cd8-b3f8-202bd276bc1d";
const otherCommitmentId = "18ae9795-a93a-4ed2-b0de-5cff41a809a0";
const operationRequestId = "728f8f21-98d5-40c8-ae69-95013fe5b120";
const otherOperationRequestId = "d8ee9559-b276-4e2b-bdd9-249d26c4238c";
const marker = [
  "fleet-control.v1",
  commitmentId,
  "open",
  2,
  null,
  FLEET_CONTROL_PORTFOLIO_AGENT_ID,
] as const;

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  }
});

function row(id: string, name: string, remaining: string, control = marker): string {
  return `| ${id} | ${name} | owner | active | now | evidence | <!--${JSON.stringify(control)}-->${remaining} |`;
}

async function harness(options?: {
  markerOverride?: readonly unknown[];
  crashAt?: FleetControlCrashPoint;
  busy?: boolean;
  holdRun?: boolean;
  missing?: boolean;
  archived?: boolean;
  afterAdmission?: () => Promise<void>;
}) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-fleet-control-"));
  directories.push(directory);
  const ledgerPath = join(directory, "ledger.md");
  const receiptsDirectory = join(directory, "agent-requests");
  const initialMarker = options?.markerOverride ?? marker;
  await writeFile(
    ledgerPath,
    [
      "# Fleet commitments",
      "",
      "| ID | Commitment | Owner | State | Updated | Evidence | Remaining |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      row(commitmentId, "Target", "keep this", initialMarker),
      row(otherCommitmentId, "Other", "unchanged", [
        "fleet-control.v1",
        otherCommitmentId,
        "open",
        9,
        null,
        FLEET_CONTROL_PORTFOLIO_AGENT_ID,
      ]),
      "",
    ].join("\n"),
  );
  let starts = 0;
  let liveBusy = options?.busy ?? false;
  const service = new FleetCommitmentControlService({
    ledgerPath,
    receiptsDirectory,
    readPortfolioAgent: async () =>
      options?.missing
        ? null
        : {
            id: FLEET_CONTROL_PORTFOLIO_AGENT_ID,
            archivedAt: options?.archived ? "2026-09-15T00:00:00.000Z" : null,
          },
    streamAgent: (_agentId, _prompt) => {
      if (liveBusy) throw new Error("already has an active run");
      liveBusy = true;
      starts++;
      return (async function* () {
        await options?.afterAdmission?.();
        yield { type: "turn_started" as const, turnId: `turn-${starts}` };
        if (options?.holdRun) await new Promise<void>(() => {});
        liveBusy = false;
      })();
    },
    crash: options?.crashAt
      ? (point) => {
          if (point === options.crashAt) throw new Error(`crash:${point}`);
        }
      : undefined,
  });
  return {
    service,
    ledgerPath,
    receiptsDirectory,
    get starts() {
      return starts;
    },
  };
}

function operation(
  action: FleetControlAction = "pause",
  overrides: Partial<Parameters<FleetCommitmentControlService["operate"]>[0]> = {},
) {
  return {
    requestId: "transport-1",
    operationRequestId,
    commitmentId,
    action,
    expectedPriorDigest: fleetControlDigest(marker),
    expectedPortfolioAgentId: FLEET_CONTROL_PORTFOLIO_AGENT_ID,
    principalId: "service:firstmate-deck",
    ...overrides,
  };
}

describe("FleetCommitmentControlService", () => {
  it("executes one admitted turn for concurrent uses of the same operation key", async () => {
    const h = await harness();
    const [first, second] = await Promise.all([
      h.service.operate(operation()),
      h.service.operate(operation("pause", { requestId: "transport-2" })),
    ]);
    expect(h.starts).toBe(1);
    expect(second).toEqual(first);
    expect(first.lifecycle).toBe("awaiting_confirmation");
    expect(first.fingerprint).toBe(
      fleetControlDigest([
        "fleet-control.v1",
        operationRequestId,
        commitmentId,
        "pause",
        fleetControlDigest(marker),
        FLEET_CONTROL_PORTFOLIO_AGENT_ID,
      ]),
    );
  });

  it("rejects a conflicting fingerprint for the same operation key", async () => {
    const h = await harness();
    const first = h.service.operate(operation());
    expect(() => h.service.operate(operation("resume"))).toThrow("operation_request_conflict");
    await first;
    await expect(h.service.operate(operation("resume"))).rejects.toMatchObject({
      code: "operation_request_conflict",
    });
  });

  it("durably rejects distinct operations while Portfolio is busy", async () => {
    const h = await harness({ holdRun: true });
    await h.service.operate(operation("pause"));
    const pausedMarker = [
      "fleet-control.v1",
      commitmentId,
      "paused",
      3,
      operationRequestId,
      FLEET_CONTROL_PORTFOLIO_AGENT_ID,
    ] as const;
    const result = await h.service.operate(
      operation("resume", {
        operationRequestId: otherOperationRequestId,
        expectedPriorDigest: fleetControlDigest(pausedMarker),
      }),
    );
    expect(result).toMatchObject({ lifecycle: "rejected", code: "agent_busy" });
    expect(
      await h.service.operate(
        operation("resume", {
          requestId: "transport-2",
          operationRequestId: otherOperationRequestId,
          expectedPriorDigest: fleetControlDigest(pausedMarker),
        }),
      ),
    ).toEqual(result);
  });

  it("durably rejects missing, archived, target, and ledger custody identity changes", async () => {
    for (const [options, overrides, code] of [
      [{ missing: true }, {}, "portfolio_agent_missing"],
      [{ archived: true }, {}, "portfolio_agent_archived"],
      [{}, { expectedPortfolioAgentId: otherCommitmentId }, "portfolio_identity_mismatch"],
      [
        {
          markerOverride: ["fleet-control.v1", commitmentId, "open", 2, null, otherCommitmentId],
        },
        {},
        "portfolio_custody_changed",
      ],
    ] as const) {
      const h = await harness(options);
      const result = await h.service.operate(operation("pause", overrides));
      expect(result).toMatchObject({ lifecycle: "rejected", code });
    }
  });

  it("writes a same-state audit revision with changed false", async () => {
    const h = await harness();
    const result = await h.service.operate(operation("resume"));
    expect(result).toMatchObject({
      lifecycle: "awaiting_confirmation",
      strictResult: { revision: 3, changed: false },
    });
    expect(result.strictResult?.after).toEqual([
      "fleet-control.v1",
      commitmentId,
      "open",
      3,
      operationRequestId,
      FLEET_CONTROL_PORTFOLIO_AGENT_ID,
    ]);
  });

  it("durably rejects stale compare-and-swap", async () => {
    const h = await harness();
    const result = await h.service.operate(
      operation("pause", { expectedPriorDigest: "f".repeat(64) }),
    );
    expect(result).toMatchObject({ lifecycle: "rejected", code: "stale_control" });
    expect(h.starts).toBe(0);
  });

  it("requires the exact Deck principal for confirmation, even with owner permissions", async () => {
    const h = await harness();
    await h.service.operate(operation());
    for (const principalId of ["owner", "plugin:deck", "caller:forged"]) {
      await expect(
        h.service.confirm({
          requestId: `confirm-${principalId}`,
          operationRequestId,
          commitmentId,
          principalId,
        }),
      ).rejects.toMatchObject({ code: "confirmation_access_denied" });
    }
    const completed = await h.service.confirm({
      requestId: "confirm-service",
      operationRequestId,
      commitmentId,
      principalId: "service:firstmate-deck",
    });
    expect(completed.lifecycle).toBe("completed");
  });

  it.each([
    ["before_ledger_write", "failed"],
    ["after_ledger_write_before_strict_result", "outcome_unknown"],
  ] as const)("does not replay after a crash at %s", async (crashAt, lifecycle) => {
    const h = await harness({ crashAt });
    await expect(h.service.operate(operation())).rejects.toThrow(`crash:${crashAt}`);
    const restarted = new FleetCommitmentControlService({
      ledgerPath: h.ledgerPath,
      receiptsDirectory: h.receiptsDirectory,
      readPortfolioAgent: async () => ({
        id: FLEET_CONTROL_PORTFOLIO_AGENT_ID,
        archivedAt: null,
      }),
      streamAgent: () => {
        throw new Error("must not replay");
      },
    });
    expect(await restarted.operate(operation())).toMatchObject({ lifecycle });
  });

  it("restarts from strict success by confirming only", async () => {
    const h = await harness({ crashAt: "after_strict_result_before_confirmation" });
    await expect(h.service.operate(operation())).rejects.toThrow(
      "crash:after_strict_result_before_confirmation",
    );
    const restarted = new FleetCommitmentControlService({
      ledgerPath: h.ledgerPath,
      receiptsDirectory: h.receiptsDirectory,
      readPortfolioAgent: async () => ({
        id: FLEET_CONTROL_PORTFOLIO_AGENT_ID,
        archivedAt: null,
      }),
      streamAgent: () => {
        throw new Error("must not replay");
      },
    });
    expect(await restarted.operate(operation())).toMatchObject({
      lifecycle: "awaiting_confirmation",
    });
    expect(
      await restarted.confirm({
        requestId: "confirmation",
        operationRequestId,
        commitmentId,
        principalId: "service:firstmate-deck",
      }),
    ).toMatchObject({ lifecycle: "completed" });
  });

  it("returns the completed receipt after the confirmation response is lost", async () => {
    const h = await harness({ crashAt: "after_confirmation_persistence" });
    await h.service.operate(operation());
    await expect(
      h.service.confirm({
        requestId: "confirmation-1",
        operationRequestId,
        commitmentId,
        principalId: "service:firstmate-deck",
      }),
    ).rejects.toThrow("crash:after_confirmation_persistence");
    const receipt = await h.service.confirm({
      requestId: "confirmation-2",
      operationRequestId,
      commitmentId,
      principalId: "service:firstmate-deck",
    });
    expect(receipt.lifecycle).toBe("completed");
  });

  it("preserves unrelated rows and a concurrent unrelated edit", async () => {
    let h!: Awaited<ReturnType<typeof harness>>;
    h = await harness({
      afterAdmission: async () => {
        const current = await readFile(h.ledgerPath, "utf8");
        await writeFile(
          h.ledgerPath,
          current.replace("# Fleet commitments", "# Fleet commitments\n\nexternal edit"),
        );
      },
    });
    await h.service.operate(operation());
    const after = await readFile(h.ledgerPath, "utf8");
    expect(after).toContain("external edit");
    expect(after).toContain("-->keep this |");
    expect(after).toContain(
      row(otherCommitmentId, "Other", "unchanged", [
        "fleet-control.v1",
        otherCommitmentId,
        "open",
        9,
        null,
        FLEET_CONTROL_PORTFOLIO_AGENT_ID,
      ]),
    );
    expect(after).toContain("# Fleet commitments");
  });
});
