import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FLEET_CONTROL_PORTFOLIO_AGENT_ID,
  type FleetControlAction,
  type FleetControlReceipt,
} from "@getpaseo/protocol/fleet-control";
import {
  FleetCommitmentControlService,
  fleetControlDigest,
  type FleetControlCrashPoint,
} from "./fleet-commitment-control.js";
import { MessageReceipts } from "./message-receipts/index.js";

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
  beforeLedgerRename?: () => Promise<void>;
  afterWriteStartedReceipt?: () => Promise<void>;
  ledgerContents?: string;
  admissionLifecycle?: "running" | "error" | "initializing";
}) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-fleet-control-"));
  directories.push(directory);
  const ledgerPath = join(directory, "ledger.md");
  const receiptsDirectory = join(directory, "agent-requests");
  const initialMarker = options?.markerOverride ?? marker;
  const defaultContents = [
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
  ].join("\n");
  await writeFile(ledgerPath, options?.ledgerContents ?? defaultContents);
  let starts = 0;
  let liveBusy = options?.busy ?? false;
  let currentAgent: { id: string; archivedAt: string | null } | null = options?.missing
    ? null
    : {
        id: FLEET_CONTROL_PORTFOLIO_AGENT_ID,
        archivedAt: options?.archived ? "2026-09-15T00:00:00.000Z" : null,
      };
  class FixtureReceipts extends MessageReceipts {
    private mutated = false;

    override async writeFleetControlReceipt(receipt: FleetControlReceipt): Promise<void> {
      await super.writeFleetControlReceipt(receipt);
      if (receipt.ledgerWriteStarted && !this.mutated) {
        this.mutated = true;
        await options?.afterWriteStartedReceipt?.();
      }
    }
  }
  const createService = () =>
    new FleetCommitmentControlService({
      ledgerPath,
      receipts: new FixtureReceipts(receiptsDirectory),
      readPortfolioAgent: async () => currentAgent,
      streamAgent: (_agentId, _prompt) => {
        if (options?.admissionLifecycle) {
          throw new Error(
            `Agent ${FLEET_CONTROL_PORTFOLIO_AGENT_ID} is not idle (${options.admissionLifecycle})`,
          );
        }
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
      beforeLedgerRename: options?.beforeLedgerRename,
      crash: options?.crashAt
        ? (point) => {
            if (point === options.crashAt) throw new Error(`crash:${point}`);
          }
        : undefined,
    });
  const service = createService();
  return {
    service,
    createService,
    ledgerPath,
    receiptsDirectory,
    get starts() {
      return starts;
    },
    setAgent(agent: typeof currentAgent) {
      currentAgent = agent;
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

  it("executes a same-key operation once across service instances", async () => {
    const h = await harness();
    const otherService = h.createService();
    const [first, second] = await Promise.all([
      h.service.operate(operation()),
      otherService.operate(operation("pause", { requestId: "transport-2" })),
    ]);
    expect(h.starts).toBe(1);
    expect(second).toEqual(first);
  });

  it("rejects distinct fingerprints racing on one key across service instances", async () => {
    const h = await harness();
    const results = await Promise.allSettled([
      h.service.operate(operation("pause")),
      h.createService().operate(operation("resume", { requestId: "transport-2" })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "operation_request_conflict" }),
      }),
    ]);
    expect(h.starts).toBe(1);
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

  it.each([
    ["running", "agent_busy"],
    ["error", "portfolio_agent_error"],
    ["initializing", "portfolio_agent_initializing"],
  ] as const)("durably rejects Portfolio lifecycle %s", async (lifecycle, code) => {
    const h = await harness({ admissionLifecycle: lifecycle });
    const result = await h.service.operate(operation());
    expect(result).toMatchObject({ lifecycle: "rejected", code });
    expect(await h.createService().operate(operation())).toEqual(result);
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
    for (const principalId of ["owner", "plugin:deck", "hub:workspace-write", "caller:forged"]) {
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
    [null, "portfolio_agent_missing"],
    [
      { id: FLEET_CONTROL_PORTFOLIO_AGENT_ID, archivedAt: "2026-09-15T00:00:00.000Z" },
      "portfolio_agent_archived",
    ],
    [{ id: otherCommitmentId, archivedAt: null }, "portfolio_identity_mismatch"],
  ] as const)(
    "does not confirm after Portfolio identity or custody changes",
    async (agent, code) => {
      const h = await harness();
      await h.service.operate(operation());
      h.setAgent(agent);
      const result = await h.service.confirm({
        requestId: "confirmation",
        operationRequestId,
        commitmentId,
        principalId: "service:firstmate-deck",
      });
      expect(result).toMatchObject({ lifecycle: "rejected", code });
    },
  );

  it.each([
    ["before_ledger_write", "failed"],
    ["after_ledger_write_before_strict_result", "outcome_unknown"],
  ] as const)("does not replay after a crash at %s", async (crashAt, lifecycle) => {
    const h = await harness({ crashAt });
    await expect(h.service.operate(operation())).rejects.toThrow(`crash:${crashAt}`);
    const restarted = new FleetCommitmentControlService({
      ledgerPath: h.ledgerPath,
      receipts: new MessageReceipts(h.receiptsDirectory),
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
      receipts: new MessageReceipts(h.receiptsDirectory),
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

  it("rereads under the ledger lock before rename and preserves an unrelated edit", async () => {
    let h!: Awaited<ReturnType<typeof harness>>;
    h = await harness({
      beforeLedgerRename: async () => {
        const current = await readFile(h.ledgerPath, "utf8");
        await writeFile(
          h.ledgerPath,
          current.replace("# Fleet commitments", "# external\n# Fleet commitments"),
        );
      },
    });
    const result = await h.service.operate(operation());
    expect(result.lifecycle).toBe("awaiting_confirmation");
    expect(await readFile(h.ledgerPath, "utf8")).toContain("# external");
  });

  it("does not overwrite an unrelated edit made while write-started receipt persists", async () => {
    let h!: Awaited<ReturnType<typeof harness>>;
    h = await harness({
      afterWriteStartedReceipt: async () => {
        const current = await readFile(h.ledgerPath, "utf8");
        await writeFile(h.ledgerPath, current.replace("Other", "Other changed during receipt"));
      },
    });

    const result = await h.service.operate(operation());

    expect(result).toMatchObject({
      lifecycle: "outcome_unknown",
      code: "atomic_file_source_changed",
      ledgerWriteStarted: true,
    });
    const written = await readFile(h.ledgerPath, "utf8");
    expect(written).toContain("Other changed during receipt");
    expect(written).toContain(JSON.stringify(marker));
  });

  it("does not rename over an unrelated edit made while the ledger temp file is prepared", async () => {
    const h = await harness();
    const originalWriteFile = fs.writeFile.bind(fs);
    const ledgerTempPrefix = `.${basename(h.ledgerPath)}.`;
    let mutated = false;
    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      await originalWriteFile(file, data, options);
      if (!mutated && typeof file === "string" && basename(file).startsWith(ledgerTempPrefix)) {
        mutated = true;
        const current = await readFile(h.ledgerPath, "utf8");
        await originalWriteFile(
          h.ledgerPath,
          current.replace("Other", "Other changed during temp preparation"),
          "utf8",
        );
      }
    });
    try {
      const result = await h.service.operate(operation());
      expect(result).toMatchObject({
        lifecycle: "outcome_unknown",
        code: "atomic_file_source_changed",
        ledgerWriteStarted: true,
      });
      const written = await readFile(h.ledgerPath, "utf8");
      expect(written).toContain("Other changed during temp preparation");
      expect(written).toContain(JSON.stringify(marker));
    } finally {
      writeSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves ledger permissions and ownership during replacement",
    async () => {
      const h = await harness();
      await fs.chmod(h.ledgerPath, 0o600);
      const before = await fs.stat(h.ledgerPath);

      expect((await h.service.operate(operation())).lifecycle).toBe("awaiting_confirmation");

      const after = await fs.stat(h.ledgerPath);
      expect(after.mode & 0o7777).toBe(0o600);
      expect({ uid: after.uid, gid: after.gid }).toEqual({ uid: before.uid, gid: before.gid });
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not replace the ledger when source metadata changes during temp preparation",
    async () => {
      const h = await harness();
      await fs.chmod(h.ledgerPath, 0o600);
      const original = await readFile(h.ledgerPath, "utf8");
      const originalWriteFile = fs.writeFile.bind(fs);
      const ledgerTempPrefix = `.${basename(h.ledgerPath)}.`;
      let mutated = false;
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        await originalWriteFile(file, data, options);
        if (!mutated && typeof file === "string" && basename(file).startsWith(ledgerTempPrefix)) {
          mutated = true;
          await fs.chmod(h.ledgerPath, 0o640);
        }
      });
      try {
        const result = await h.service.operate(operation());
        expect(result).toMatchObject({
          lifecycle: "outcome_unknown",
          code: "atomic_file_source_changed",
          ledgerWriteStarted: true,
        });
        expect(await readFile(h.ledgerPath, "utf8")).toBe(original);
        expect((await fs.stat(h.ledgerPath)).mode & 0o7777).toBe(0o640);
      } finally {
        writeSpy.mockRestore();
      }
    },
  );

  it("rejects a target marker changed immediately before rename", async () => {
    let h!: Awaited<ReturnType<typeof harness>>;
    const changedMarker = [
      "fleet-control.v1",
      commitmentId,
      "paused",
      3,
      otherOperationRequestId,
      FLEET_CONTROL_PORTFOLIO_AGENT_ID,
    ] as const;
    h = await harness({
      beforeLedgerRename: async () => {
        const current = await readFile(h.ledgerPath, "utf8");
        await writeFile(
          h.ledgerPath,
          current.replace(JSON.stringify(marker), JSON.stringify(changedMarker)),
        );
      },
    });
    const result = await h.service.operate(operation());
    expect(result).toMatchObject({ lifecycle: "rejected", code: "stale_control" });
    expect(await readFile(h.ledgerPath, "utf8")).toContain(JSON.stringify(changedMarker));
  });

  it("allows only one service instance to pass the same ledger CAS", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-fleet-control-race-"));
    directories.push(directory);
    const ledgerPath = join(directory, "ledger.md");
    const receiptsDirectory = join(directory, "agent-requests");
    await mkdir(receiptsDirectory);
    await writeFile(ledgerPath, `${row(commitmentId, "Target", "keep")}\nexternal-before\n`);
    const service = () =>
      new FleetCommitmentControlService({
        ledgerPath,
        receipts: new MessageReceipts(receiptsDirectory),
        readPortfolioAgent: async () => ({
          id: FLEET_CONTROL_PORTFOLIO_AGENT_ID,
          archivedAt: null,
        }),
        streamAgent: () =>
          (async function* () {
            yield { type: "turn_started", turnId: crypto.randomUUID() };
          })(),
      });
    const [pause, resume] = await Promise.all([
      service().operate(operation("pause")),
      service().operate(operation("resume", { operationRequestId: otherOperationRequestId })),
    ]);
    expect([pause.lifecycle, resume.lifecycle].sort()).toEqual([
      "awaiting_confirmation",
      "rejected",
    ]);
    expect([pause.code, resume.code]).toContain("stale_control");
    expect(await readFile(ledgerPath, "utf8")).toContain("external-before");
  });

  it("recovers a dead-owner ledger lock without bypassing the transaction", async () => {
    const h = await harness();
    await writeFile(
      `${h.ledgerPath}.fleet-control.lock`,
      JSON.stringify({
        pid: 2_147_483_647,
        processStartedAt: "2025-12-31T23:59:59.000Z",
        token: "stale",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await expect(h.service.operate(operation())).resolves.toMatchObject({
      lifecycle: "awaiting_confirmation",
    });
    await expect(readFile(`${h.ledgerPath}.fleet-control.lock`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed on malformed ledger lock ownership", async () => {
    const h = await harness();
    await writeFile(`${h.ledgerPath}.fleet-control.lock`, "not lock metadata");
    await expect(h.service.operate(operation())).resolves.toMatchObject({
      lifecycle: "rejected",
      code: "file_lock_invalid",
    });
    expect(await readFile(h.ledgerPath, "utf8")).toContain(JSON.stringify(marker));
  });

  it("preserves CRLF, escaped pipes and backslashes across multiple tables", async () => {
    const escaped = `| ${commitmentId} | Target \\| path \\\\ root | owner | active | now | evidence | <!--${JSON.stringify(marker)}-->keep |`;
    const contents = [
      "| A | B |",
      "| --- | --- |",
      "| unrelated | table |",
      "",
      escaped,
      `| ${otherCommitmentId} | Other | owner | active | now | evidence | <!--["fleet-control.v1","${otherCommitmentId}","open",1,null,"${FLEET_CONTROL_PORTFOLIO_AGENT_ID}"]-->other |`,
      "",
    ].join("\r\n");
    const h = await harness({ ledgerContents: contents });
    const result = await h.service.operate(operation());
    expect(result.lifecycle).toBe("awaiting_confirmation");
    const written = await readFile(h.ledgerPath, "utf8");
    expect(written).toContain("Target \\| path \\\\ root");
    expect(written.match(/\r\n/gu)?.length).toBe(contents.match(/\r\n/gu)?.length);
    expect(written).toContain("| unrelated | table |");
  });

  it("splices only the column-seven marker when identical text appears in Evidence", async () => {
    const markerText = `<!--${JSON.stringify(marker)}-->`;
    const sourceRow = `| ${commitmentId} | Target \\| path \\\\ root | owner | active | now | evidence ${markerText} | ${markerText}keep |`;
    const contents = `${sourceRow}\r\n`;
    const h = await harness({ ledgerContents: contents });

    const result = await h.service.operate(operation());

    expect(result.lifecycle).toBe("awaiting_confirmation");
    const afterMarker = [
      "fleet-control.v1",
      commitmentId,
      "paused",
      3,
      operationRequestId,
      FLEET_CONTROL_PORTFOLIO_AGENT_ID,
    ] as const;
    expect(result.strictResult?.after).toEqual(afterMarker);
    expect(await readFile(h.ledgerPath, "utf8")).toBe(
      sourceRow.replace(`| ${markerText}keep |`, `| <!--${JSON.stringify(afterMarker)}-->keep |`) +
        "\r\n",
    );
  });

  it("rejects duplicate control markers during startup readiness", async () => {
    const duplicate = `| ${commitmentId} | Target | owner | active | now | evidence | <!--${JSON.stringify(marker)}--><!--${JSON.stringify(marker)}-->keep |\n`;
    await expect(harness({ ledgerContents: duplicate })).rejects.toThrow(
      "Fleet commitment ledger is not ready",
    );
  });

  it("rejects non-compact and out-of-row startup control markers", async () => {
    const spacedMarker = JSON.stringify(marker, null, 1).replaceAll("\n", "");
    await expect(
      harness({
        ledgerContents: `${row(commitmentId, "Target", "keep").replace(JSON.stringify(marker), spacedMarker)}\n`,
      }),
    ).rejects.toThrow("Fleet commitment ledger is not ready");
    await expect(
      harness({
        ledgerContents: `<!--${JSON.stringify(marker)}-->\n${row(commitmentId, "Target", "keep")}\n`,
      }),
    ).rejects.toThrow("Fleet commitment ledger is not ready");
  });

  it("rejects the same commitment row repeated across Markdown tables", async () => {
    await expect(
      harness({
        ledgerContents: [
          "| ID | Commitment | Owner | State | Updated | Evidence | Remaining |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          row(commitmentId, "First", "keep"),
          "",
          "| ID | Commitment | Owner | State | Updated | Evidence | Remaining |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          row(commitmentId, "Second", "keep"),
          "",
        ].join("\n"),
      }),
    ).rejects.toThrow("Fleet commitment ledger is not ready");
  });
});
