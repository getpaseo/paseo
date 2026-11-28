import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTrigger, defineWorkflow, expr, ref, step, terminal, tpl } from "../src/dsl.js";
import {
  createWorkflowEngine,
  type EventActor,
  type JsonObject,
  type NormalizedIntegrationEvent,
  type WorkflowIntegration,
  type WorkflowIR,
} from "../src/index.js";
import {
  createFakeAgentRunner,
  createFakeClock,
  createFakeGateSink,
  createMemoryIntegrationConnections,
  createMemoryIntegrationStorage,
  createMemoryWorkflowStore,
} from "../src/testing.js";

/** Enforces Hard Mechanical Boundary 2: every IR passes through JSON round-trip before execution. */
function roundTripIR(ir: WorkflowIR): WorkflowIR {
  return JSON.parse(JSON.stringify(ir)) as WorkflowIR;
}

interface AcmeHarness {
  readonly integration: WorkflowIntegration;
  readonly activeLeases: Set<string>;
  readonly mintedLeases: string[];
  readonly revokedLeases: string[];
  readonly mergedPrs: JsonObject[];
  readonly closedIssues: JsonObject[];
}

function createAcmeIntegration(): AcmeHarness {
  const activeLeases = new Set<string>();
  const mintedLeases: string[] = [];
  const revokedLeases: string[] = [];
  const mergedPrs: JsonObject[] = [];
  const closedIssues: JsonObject[] = [];
  let leaseSeq = 0;

  const integration: WorkflowIntegration = {
    id: "acme",
    triggers: {
      "acme.issue_created": {
        event: "acme.issue_created",
        filterSchema: z.object({ repo: z.string().optional() }),
      },
      "acme.ci_status": {
        event: "acme.ci_status",
      },
    },
    auth: {
      async mint(scope, ctx) {
        const leaseId = `acme_lease_${++leaseSeq}`;
        activeLeases.add(leaseId);
        mintedLeases.push(leaseId);
        await ctx.storage.set(`lease:${leaseId}`, { scope: scope as JsonObject, active: true });
        return {
          leaseId,
          env: { ACME_TOKEN: `secret_${leaseId}` },
        };
      },
      async revoke(leaseId, ctx) {
        activeLeases.delete(leaseId);
        revokedLeases.push(leaseId);
        await ctx.storage.delete(`lease:${leaseId}`);
      },
    },
    steps: {
      wait_ci: {
        inputSchema: z.object({
          repo: z.string(),
          pr_number: z.number().int(),
          head_sha: z.string(),
        }),
        outputSchema: z.object({
          conclusion: z.string(),
          failure_summary: z.string().nullable().optional(),
        }),
        outcomes: ["green", "red", "timeout"],
        async execute(input) {
          const waitKey = `ci:${String(input["repo"])}#${String(input["pr_number"])}@${String(input["head_sha"])}`;
          return { status: "suspended", waitKey };
        },
        async onEvent(event, input) {
          if (event.type !== "acme.ci_status") {
            return { status: "still_waiting" };
          }
          if (
            event.payload["repo"] !== input["repo"] ||
            event.payload["pr_number"] !== input["pr_number"] ||
            event.payload["head_sha"] !== input["head_sha"]
          ) {
            return { status: "still_waiting" };
          }
          const state = event.payload["state"];
          if (state === "pending") {
            return { status: "still_waiting" };
          }
          if (state === "green") {
            return {
              status: "completed",
              outcome: "green",
              output: { conclusion: "green", failure_summary: null },
            };
          }
          return {
            status: "completed",
            outcome: "red",
            output: {
              conclusion: "red",
              failure_summary:
                typeof event.payload["summary"] === "string"
                  ? event.payload["summary"]
                  : "tests failed",
            },
          };
        },
      },
      merge_pr: {
        inputSchema: z.object({
          repo: z.string(),
          pr_number: z.number().int(),
          note: z.string().optional(),
        }),
        outputSchema: z.object({ merged: z.boolean() }),
        outcomes: ["merged", "conflict"],
        async execute(input) {
          mergedPrs.push(structuredClone(input));
          return { status: "completed", outcome: "merged", output: { merged: true } };
        },
      },
      close_issue: {
        inputSchema: z.object({
          repo: z.string(),
          issue_number: z.number().int(),
          comment: z.string(),
        }),
        outcomes: ["closed"],
        async execute(input) {
          closedIssues.push(structuredClone(input));
          return { status: "completed", outcome: "closed", output: { closed: true } };
        },
      },
    },
    tools: {
      grantSchema: z.object({ repo: z.string(), allowWrite: z.boolean() }),
      tools: [
        {
          name: "acme.post_note",
          description: "Post a note on an Acme item",
          inputSchema: {
            type: "object",
            required: ["body"],
            properties: { body: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
      async execute(tool, args, grant, ctx) {
        if (tool !== "acme.post_note") {
          throw new Error(`unknown tool ${tool}`);
        }
        await ctx.storage.set("last_tool_note", {
          body: args["body"] ?? "",
          grant,
        });
        return { ok: true };
      },
    },
  };

  return { integration, activeLeases, mintedLeases, revokedLeases, mergedPrs, closedIssues };
}

function makeEvent(
  type: string,
  payload: JsonObject,
  options: {
    readonly id?: string;
    readonly connection?: string;
    readonly actor?: EventActor;
    readonly prompt?: string;
    readonly occurredAt?: Date;
  } = {},
): NormalizedIntegrationEvent {
  return {
    id: options.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    type,
    connection: options.connection ?? "acme-main",
    actor: options.actor ?? { id: "u1", login: "alice", isBot: false, isSelfApp: false },
    payload,
    prompt: options.prompt,
    occurredAt: options.occurredAt ?? new Date("2026-06-01T00:00:00.000Z"),
  };
}

describe("fake acme integration end-to-end engine contract", () => {
  it("runs a 1-state shorthand trigger, enforces filters, and revokes auth lease after completion", async () => {
    const acme = createAcmeIntegration();
    const clock = createFakeClock();
    const runner = createFakeAgentRunner((req) => {
      // Auth token MUST be active while the agent step runs.
      expect(req.env["ACME_TOKEN"]).toMatch(/^secret_acme_lease_/);
      expect(acme.activeLeases.size).toBe(1);
      return { status: "completed", outcome: "ok", output: { handled: true } };
    });

    const triggerIR = roundTripIR(
      defineTrigger({
        name: "acme-mention",
        on: {
          "acme.comment": {
            connection: "acme-main",
            filters: {
              repo: "acme/widget",
              from_users: ["alice"],
              contains: "@bot",
              exclude_contains: "@bot ignore",
            },
          },
        },
        run: {
          auth: { acme: { connection: "acme-main" } },
          prompt: tpl`Handle comment on #${ref("event.item.number")}: ${ref("paseo.prompt")}`,
        },
      }),
    );

    const engine = createWorkflowEngine({
      store: createMemoryWorkflowStore(),
      runner,
      gates: createFakeGateSink(),
      integrations: [acme.integration],
      clock,
      workflows: [triggerIR],
    });

    // Ignored because of exclude_contains
    const ignored = await engine.ingest(
      makeEvent(
        "acme.comment",
        { repo: "acme/widget", item: { number: 7 } },
        { prompt: "@bot ignore this" },
      ),
    );
    expect(ignored.matchedRuns).toHaveLength(0);

    // Matched
    const matched = await engine.ingest(
      makeEvent(
        "acme.comment",
        { repo: "acme/widget", item: { number: 7 } },
        { prompt: "@bot fix please" },
      ),
    );
    expect(matched.matchedRuns).toHaveLength(1);
    expect(matched.matchedRuns[0]?.status).toBe("done");
    expect(runner.requests[0]?.prompt).toBe("Handle comment on #7: @bot fix please");
    expect(acme.mintedLeases).toHaveLength(1);
    expect(acme.revokedLeases).toEqual(acme.mintedLeases);
    expect(acme.activeLeases.size).toBe(0);
  });

  it("drives full issue -> fix -> acme.wait_ci suspend/resume -> wait.workflow (dispatchIfMissing) -> merge", async () => {
    const acme = createAcmeIntegration();
    const clock = createFakeClock();
    const gates = createFakeGateSink();

    const reviewIR = roundTripIR(
      defineWorkflow({
        id: "acme-review",
        on: { "manual.run": {} },
        inputs: {
          repo: { type: "string", default: "acme/widget" },
          pr_number: { type: "number" },
          head_sha: { type: "string" },
        },
        initial: "review",
        steps: {
          review: step.agent({
            auth: { acme: { connection: "acme-main" } },
            prompt: tpl`Review #${ref("inputs.pr_number")}@${ref("inputs.head_sha")}`,
            output: z.object({
              outcome: z.enum(["approved", "changes_requested"]),
              confidence: z.number().int(),
            }),
            on: {
              approved: terminal.done(),
              changes_requested: terminal.done(),
            },
          }),
        },
        publish: {
          key: tpl`review:${ref("inputs.repo")}#${ref("inputs.pr_number")}@${ref("inputs.head_sha")}`,
          payload: {
            verdict: ref("steps.review.outputs.outcome"),
            confidence: ref("steps.review.outputs.confidence"),
          },
        },
      }),
    );

    const issueToPrIR = roundTripIR(
      defineWorkflow({
        id: "acme-issue-to-pr",
        on: {
          "acme.issue_created": {
            connection: "acme-main",
            filters: { repo: "acme/widget" },
          },
        },
        subject: {
          key: tpl`${ref("event.repo")}#${ref("event.issue_number")}`,
          onConflict: "ignore",
        },
        initial: "fix",
        steps: {
          fix: step.agent({
            maxLoops: 3,
            auth: { acme: { connection: "acme-main" } },
            prompt: tpl`Fix #${ref("event.issue_number")}`,
            output: z.object({
              outcome: z.enum(["pr_ready"]),
              pr_number: z.number().int(),
              head_sha: z.string(),
            }),
            on: {
              pr_ready: "wait_ci",
              max_loops_exceeded: terminal.failed("too_many_loops"),
            },
          }),
          wait_ci: step.integration("acme.wait_ci", {
            input: {
              repo: ref("event.repo"),
              pr_number: ref("steps.fix.outputs.pr_number"),
              head_sha: ref("steps.fix.outputs.head_sha"),
            },
            timeout: "60m",
            on: {
              green: "wait_review",
              red: "fix",
              timeout: terminal.failed("ci_timeout"),
            },
          }),
          wait_review: step.waitWorkflow({
            workflow: "acme-review",
            outputKey: tpl`review:${ref("event.repo")}#${ref("steps.fix.outputs.pr_number")}@${ref("steps.fix.outputs.head_sha")}`,
            dispatchIfMissing: true,
            inputs: {
              repo: ref("event.repo"),
              pr_number: ref("steps.fix.outputs.pr_number"),
              head_sha: ref("steps.fix.outputs.head_sha"),
            },
            timeout: "30m",
            on: {
              approved: "merge",
              changes_requested: "fix",
              timeout: terminal.failed("review_timeout"),
            },
          }),
          merge: step.integration("acme.merge_pr", {
            auth: { acme: { connection: "acme-main" } },
            input: {
              repo: ref("event.repo"),
              pr_number: ref("steps.fix.outputs.pr_number"),
            },
            on: { merged: terminal.done() },
          }),
        },
      }),
    );

    const pendingReviewExecs: { runId: string; executionId: string }[] = [];
    const runner = createFakeAgentRunner((req) => {
      if (req.workflowId === "acme-issue-to-pr" && req.stepId === "fix") {
        return {
          status: "completed",
          output: { outcome: "pr_ready", pr_number: 55, head_sha: "sha_1" },
        };
      }
      if (req.workflowId === "acme-review") {
        pendingReviewExecs.push({ runId: req.runId, executionId: req.executionId });
        return { status: "running", executionId: req.executionId };
      }
      throw new Error(`unexpected agent request ${req.workflowId}:${req.stepId}`);
    });

    const engine = createWorkflowEngine({
      store: createMemoryWorkflowStore(),
      runner,
      gates,
      integrations: [acme.integration],
      clock,
      workflows: [reviewIR, issueToPrIR],
    });

    // 1. Issue arrives -> fix runs & completes -> suspends in acme.wait_ci with ZERO active leases.
    const ingested = await engine.ingest(
      makeEvent("acme.issue_created", { repo: "acme/widget", issue_number: 10 }),
    );
    const parentRunId = ingested.matchedRuns[0]!.id;
    expect(ingested.matchedRuns[0]?.status).toBe("waiting");
    expect(ingested.matchedRuns[0]?.currentState).toBe("wait_ci");
    expect(acme.activeLeases.size).toBe(0);

    // 2. Pending CI event keeps waiting (still_waiting).
    const pendingCi = await engine.ingest(
      makeEvent("acme.ci_status", {
        repo: "acme/widget",
        pr_number: 55,
        head_sha: "sha_1",
        state: "pending",
      }),
    );
    expect(pendingCi.resumedRuns).toHaveLength(0);
    expect((await engine.getRun(parentRunId))?.currentState).toBe("wait_ci");

    // 3. Green CI event resumes -> enters wait_review -> auto-dispatches acme-review!
    const greenCi = await engine.ingest(
      makeEvent("acme.ci_status", {
        repo: "acme/widget",
        pr_number: 55,
        head_sha: "sha_1",
        state: "green",
      }),
    );
    expect(greenCi.resumedRuns).toHaveLength(1);
    expect((await engine.getRun(parentRunId))?.currentState).toBe("wait_review");
    expect((await engine.getRun(parentRunId))?.status).toBe("waiting");
    expect(pendingReviewExecs).toHaveLength(1);
    // Review agent is running, holding its own lease.
    expect(acme.activeLeases.size).toBe(1);

    // 4. Async review completes -> publishes verdict -> wakes parent -> merges PR -> done!
    const reviewRun = await engine.completeAgentStep({
      runId: pendingReviewExecs[0]!.runId,
      executionId: pendingReviewExecs[0]!.executionId,
      output: { outcome: "approved", confidence: 5 },
    });
    expect(reviewRun.status).toBe("done");

    const finalParent = await engine.getRun(parentRunId);
    expect(finalParent?.status).toBe("done");
    expect(acme.mergedPrs).toEqual([{ repo: "acme/widget", pr_number: 55 }]);
    expect(acme.activeLeases.size).toBe(0);
    expect(acme.revokedLeases.length).toBe(acme.mintedLeases.length);
  });

  it("handles wait.workflow race-free cache-hit AND synchronous dispatchIfMissing completion", async () => {
    const acme = createAcmeIntegration();
    const clock = createFakeClock();
    let reviewCalls = 0;

    const reviewIR = roundTripIR(
      defineWorkflow({
        id: "acme-review",
        on: { "manual.run": {} },
        inputs: { pr_number: { type: "number" }, head_sha: { type: "string" } },
        initial: "review",
        steps: {
          review: step.agent({
            prompt: tpl`Review #${ref("inputs.pr_number")}`,
            output: z.object({ outcome: z.enum(["approved"]) }),
            on: { approved: terminal.done() },
          }),
        },
        publish: {
          key: tpl`review:acme/widget#${ref("inputs.pr_number")}@${ref("inputs.head_sha")}`,
          payload: { verdict: ref("steps.review.outputs.outcome") },
        },
      }),
    );

    const consumerIR = roundTripIR(
      defineWorkflow({
        id: "acme-consumer",
        on: { "manual.run": {} },
        inputs: { pr_number: { type: "number" }, head_sha: { type: "string" } },
        initial: "wait_review",
        steps: {
          wait_review: step.waitWorkflow({
            workflow: "acme-review",
            outputKey: tpl`review:acme/widget#${ref("inputs.pr_number")}@${ref("inputs.head_sha")}`,
            dispatchIfMissing: true,
            inputs: { pr_number: ref("inputs.pr_number"), head_sha: ref("inputs.head_sha") },
            on: { approved: terminal.done("got_review") },
          }),
        },
      }),
    );

    const runner = createFakeAgentRunner(() => {
      reviewCalls += 1;
      return { status: "completed", output: { outcome: "approved" } };
    });

    const engine = createWorkflowEngine({
      store: createMemoryWorkflowStore(),
      runner,
      gates: createFakeGateSink(),
      integrations: [acme.integration],
      clock,
      workflows: [reviewIR, consumerIR],
    });

    // Case 1: Cache hit (published BEFORE wait_review runs -> zero extra review dispatch!)
    await engine.start({
      workflowId: "acme-review",
      inputs: { pr_number: 1, head_sha: "sha_cached" },
    });
    expect(reviewCalls).toBe(1);

    const cachedConsumer = await engine.start({
      workflowId: "acme-consumer",
      inputs: { pr_number: 1, head_sha: "sha_cached" },
    });
    expect(cachedConsumer.status).toBe("done");
    expect(cachedConsumer.terminalReason).toBe("got_review");
    expect(reviewCalls).toBe(1);

    // Case 2: Cache miss + synchronous child completion during dispatchIfMissing -> zero race!
    const dispatchedConsumer = await engine.start({
      workflowId: "acme-consumer",
      inputs: { pr_number: 2, head_sha: "sha_sync" },
    });
    expect(dispatchedConsumer.status).toBe("done");
    expect(dispatchedConsumer.terminalReason).toBe("got_review");
    expect(reviewCalls).toBe(2);
  });

  it("enforces maxLoops + max_loops_exceeded, native gate choices + notes, and gate timeout", async () => {
    const acme = createAcmeIntegration();
    const clock = createFakeClock();
    const gates = createFakeGateSink();
    let fixAttempts = 0;

    const workflowIR = roundTripIR(
      defineWorkflow({
        id: "acme-loop-and-gate",
        on: { "acme.issue_created": {} },
        initial: "fix",
        steps: {
          fix: step.agent({
            maxLoops: 2,
            prompt: tpl`Attempt fix #${ref("event.issue_number")}`,
            on: {
              red: "fix",
              max_loops_exceeded: "maintainer_gate",
            },
          }),
          maintainer_gate: step.gate({
            title: tpl`Need decision on #${ref("event.issue_number")}`,
            summary: "Fix failed CI twice",
            recommended: "close",
            choices: [
              { id: "close", label: "Close issue" },
              { id: "waive", label: "Waive and done" },
            ],
            timeout: "7d",
            onTimeout: terminal.cancelled("gate_expired"),
            on: {
              close: "close_issue",
              waive: terminal.done("waived"),
            },
          }),
          close_issue: step.integration("acme.close_issue", {
            input: {
              repo: "acme/widget",
              issue_number: ref("event.issue_number"),
              comment: tpl`Closed by ${ref("gate.actor")}: ${ref("gate.note")}`,
            },
            on: { closed: terminal.done("closed_by_gate") },
          }),
        },
      }),
    );

    const runner = createFakeAgentRunner(() => {
      fixAttempts += 1;
      return { status: "completed", outcome: "red" };
    });

    const engine = createWorkflowEngine({
      store: createMemoryWorkflowStore(),
      runner,
      gates,
      integrations: [acme.integration],
      clock,
      workflows: [workflowIR],
    });

    // Run 1: exhausts maxLoops=2 -> opens gate -> resolved with choice + note + actor
    const run1 = await engine.start({
      workflowId: "acme-loop-and-gate",
      event: makeEvent("acme.issue_created", { issue_number: 77 }),
    });
    expect(fixAttempts).toBe(2);
    expect(run1.status).toBe("waiting");
    expect(run1.currentState).toBe("maintainer_gate");
    expect(gates.opened).toHaveLength(1);
    expect((await engine.listOpenGates({ runId: run1.id })).length).toBe(1);

    const gate1Id = gates.opened[0]!.id;
    await expect(engine.resolveGate(gate1Id, { choice: "bogus" })).rejects.toThrow(
      /invalid gate choice/i,
    );

    const resolvedRun1 = await engine.resolveGate(gate1Id, {
      choice: "close",
      note: "duplicate of #12",
      actor: "mo",
    });
    expect(resolvedRun1.status).toBe("done");
    expect(resolvedRun1.terminalReason).toBe("closed_by_gate");
    expect(gates.resolved).toHaveLength(1);
    expect(acme.closedIssues).toEqual([
      { repo: "acme/widget", issue_number: 77, comment: "Closed by mo: duplicate of #12" },
    ]);

    // Run 2: gate times out via FakeClock + tick()
    const run2 = await engine.start({
      workflowId: "acme-loop-and-gate",
      event: makeEvent("acme.issue_created", { issue_number: 78 }),
    });
    expect(run2.status).toBe("waiting");
    clock.advance(7 * 86_400_000);
    const ticked = await engine.tick();
    expect(ticked.wokenRuns).toHaveLength(1);
    expect(ticked.wokenRuns[0]?.status).toBe("cancelled");
    expect(ticked.wokenRuns[0]?.terminalReason).toBe("gate_expired");
    expect(gates.expired).toHaveLength(1);
    expect(await engine.listOpenGates()).toHaveLength(0);
  });

  it("guarantees auth lease revocation on runner error, schema failure, cancel, pause, and before wait", async () => {
    const acme = createAcmeIntegration();
    const clock = createFakeClock();

    const schemaWorkflow = roundTripIR(
      defineWorkflow({
        id: "acme-auth-test",
        on: { "manual.run": {} },
        initial: "work",
        steps: {
          work: step.agent({
            auth: { acme: { connection: "acme-main" } },
            prompt: "work",
            output: z.object({ outcome: z.enum(["ok"]), required_num: z.number().int() }),
            on: { ok: "nap" },
          }),
          nap: step.sleep({ duration: "10m", on: { done: terminal.done() } }),
        },
      }),
    );

    const runner = createFakeAgentRunner();
    const engine = createWorkflowEngine({
      store: createMemoryWorkflowStore(),
      runner,
      gates: createFakeGateSink(),
      integrations: [acme.integration],
      clock,
      workflows: [schemaWorkflow],
    });

    // 1. Runner throws error -> lease revoked
    runner.setHandler(() => {
      throw new Error("boom");
    });
    const rErr = await engine.start({ workflowId: "acme-auth-test" });
    expect(rErr.status).toBe("failed");
    expect(acme.activeLeases.size).toBe(0);

    // 2. Output fails JSON Schema validation -> lease revoked
    runner.setHandler(() => ({
      status: "completed",
      output: { outcome: "ok", required_num: "not-a-number" as unknown as number },
    }));
    const rBadOut = await engine.start({ workflowId: "acme-auth-test" });
    expect(rBadOut.status).toBe("failed");
    expect(rBadOut.terminalReason).toMatch(/validation failed/i);
    expect(acme.activeLeases.size).toBe(0);

    // 3. Async agent cancelled mid-flight -> agent cancelled & lease revoked
    runner.setHandler((req) => ({ status: "running", executionId: req.executionId }));
    const rRunning = await engine.start({ workflowId: "acme-auth-test" });
    expect(rRunning.status).toBe("running");
    expect(acme.activeLeases.size).toBe(1);
    const rCancelled = await engine.cancel(rRunning.id, "user_stop");
    expect(rCancelled.status).toBe("cancelled");
    expect(acme.activeLeases.size).toBe(0);
    expect(runner.cancelled.length).toBe(1);

    // 4. Async agent paused mid-flight -> lease revoked; resumed -> runs cleanly -> sleeps with 0 leases
    const rPauseTarget = await engine.start({ workflowId: "acme-auth-test" });
    expect(acme.activeLeases.size).toBe(1);
    const rPaused = await engine.pause(rPauseTarget.id);
    expect(rPaused.status).toBe("paused");
    expect(acme.activeLeases.size).toBe(0);

    runner.setHandler(() => ({
      status: "completed",
      output: { outcome: "ok", required_num: 42 },
    }));
    const rResumed = await engine.resume(rPauseTarget.id);
    expect(rResumed.status).toBe("waiting");
    expect(rResumed.currentState).toBe("nap");
    expect(acme.activeLeases.size).toBe(0);

    // Pause while waiting on sleep -> clock passes -> tick ignores paused -> resume completes!
    await engine.pause(rPauseTarget.id);
    clock.advance(10 * 60_000);
    expect((await engine.tick()).wokenRuns).toHaveLength(0);
    const rFinished = await engine.resume(rPauseTarget.id);
    expect(rFinished.status).toBe("done");
    expect(acme.revokedLeases.length).toBe(acme.mintedLeases.length);
  });

  it("enforces subject conflict policies (ignore, cancel_previous, queue) and when guards", async () => {
    const acme = createAcmeIntegration();
    const clock = createFakeClock();

    const makeConflictWorkflow = (
      id: string,
      onConflict: "ignore" | "cancel_previous" | "queue",
    ): WorkflowIR =>
      roundTripIR(
        defineWorkflow({
          id,
          on: { "manual.run": {} },
          inputs: { skip_first: { type: "boolean", default: false } },
          subject: { key: "acme/widget#1", onConflict },
          initial: "optional_prep",
          steps: {
            optional_prep: step.agent({
              when: expr.not(ref("inputs.skip_first")),
              prompt: "prep",
              on: { ok: "main", skipped: "main" },
            }),
            main: step.agent({
              auth: { acme: { connection: "acme-main" } },
              prompt: "main",
              on: { ok: terminal.done() },
            }),
          },
        }),
      );

    const runner = createFakeAgentRunner((req) => {
      if (req.stepId === "optional_prep") {
        return { status: "completed", outcome: "ok" };
      }
      return { status: "running", executionId: req.executionId };
    });

    const engine = createWorkflowEngine({
      store: createMemoryWorkflowStore(),
      runner,
      gates: createFakeGateSink(),
      integrations: [acme.integration],
      clock,
      workflows: [
        makeConflictWorkflow("wf-ignore", "ignore"),
        makeConflictWorkflow("wf-cancel", "cancel_previous"),
        makeConflictWorkflow("wf-queue", "queue"),
      ],
    });

    // when guard skips optional_prep when skip_first=true
    const r1 = await engine.start({ workflowId: "wf-ignore", inputs: { skip_first: true } });
    expect(r1.currentState).toBe("main");
    expect(r1.attempts[0]?.status).toBe("skipped");

    // ignore returns existing active run
    const r1Dup = await engine.start({ workflowId: "wf-ignore" });
    expect(r1Dup.id).toBe(r1.id);

    // cancel_previous supersedes and revokes previous run's lease
    const rc1 = await engine.start({ workflowId: "wf-cancel", inputs: { skip_first: true } });
    const rc2 = await engine.start({ workflowId: "wf-cancel", inputs: { skip_first: true } });
    expect(rc2.id).not.toBe(rc1.id);
    expect((await engine.getRun(rc1.id))?.status).toBe("cancelled");
    expect(acme.activeLeases.size).toBe(2); // r1 + rc2

    // queue defers second run until first finishes, then auto-starts it
    const rq1 = await engine.start({ workflowId: "wf-queue", inputs: { skip_first: true } });
    const rq2 = await engine.start({ workflowId: "wf-queue", inputs: { skip_first: true } });
    expect(rq2.status).toBe("queued");

    const rq1Exec = rq1.attempts.find((a) => a.stepId === "main")!.executionId;
    await engine.completeAgentStep({ runId: rq1.id, executionId: rq1Exec, outcome: "ok" });
    expect((await engine.getRun(rq1.id))?.status).toBe("done");
    expect((await engine.getRun(rq2.id))?.status).toBe("running");

    // listRuns filter works
    const runningRuns = await engine.listRuns({ status: "running" });
    expect(runningRuns.map((r) => r.id).sort()).toEqual([r1.id, rc2.id, rq2.id].sort());
  });

  it("supports signal conflict policy and integration tools slot over IntegrationContext", async () => {
    const acme = createAcmeIntegration();
    const clock = createFakeClock();
    const storage = createMemoryIntegrationStorage(clock);
    const connections = createMemoryIntegrationConnections([
      { id: "c1", name: "acme-main", integration: "acme" },
    ]);

    const signalWorkflow = roundTripIR(
      defineWorkflow({
        id: "acme-signal-wf",
        on: { "acme.ci_status": { connection: "acme-main" } },
        subject: {
          key: tpl`${ref("event.repo")}#${ref("event.pr_number")}`,
          onConflict: "signal",
        },
        initial: "wait_ci",
        steps: {
          wait_ci: step.integration("acme.wait_ci", {
            input: {
              repo: ref("event.repo"),
              pr_number: ref("event.pr_number"),
              head_sha: ref("event.head_sha"),
            },
            on: { green: terminal.done("signalled_green"), red: terminal.failed("red") },
          }),
        },
      }),
    );

    const engine = createWorkflowEngine({
      store: createMemoryWorkflowStore(),
      runner: createFakeAgentRunner(),
      gates: createFakeGateSink(),
      integrations: [acme.integration],
      clock,
      storage,
      connections,
      workflows: [signalWorkflow],
    });

    // First pending event opens the run and suspends in wait_ci.
    const first = await engine.start({
      workflowId: "acme-signal-wf",
      event: makeEvent("acme.ci_status", {
        repo: "acme/widget",
        pr_number: 99,
        head_sha: "sha_sig",
        state: "pending",
      }),
    });
    expect(first.status).toBe("waiting");

    // Second start on same subject with `signal` delivers the green event to the existing run!
    const signalled = await engine.start({
      workflowId: "acme-signal-wf",
      event: makeEvent("acme.ci_status", {
        repo: "acme/widget",
        pr_number: 99,
        head_sha: "sha_sig",
        state: "green",
      }),
    });
    expect(signalled.id).toBe(first.id);
    expect(signalled.status).toBe("done");
    expect(signalled.terminalReason).toBe("signalled_green");

    // Verify tools slot grant validation and execution using only IntegrationContext.
    const toolsSlot = acme.integration.tools!;
    const grant = toolsSlot.grantSchema.parse({ repo: "acme/widget", allowWrite: true });
    const toolResult = await toolsSlot.execute("acme.post_note", { body: "looks good" }, grant, {
      scopeId: "test",
      storage,
      connections,
      ingest: async (evt) => {
        await engine.ingest(evt);
      },
      fetch: globalThis.fetch.bind(globalThis),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      now: () => clock.now(),
    });
    expect(toolResult).toEqual({ ok: true });
    expect(await storage.get("last_tool_note")).toEqual({
      body: "looks good",
      grant: { repo: "acme/widget", allowWrite: true },
    });
  });

  it("honors pause across wait_workflow, integration waits, and gates, and replays wakes on resume", async () => {
    const acme = createAcmeIntegration();
    const clock = createFakeClock();
    const gates = createFakeGateSink();

    const waitWfIR = roundTripIR(
      defineWorkflow({
        id: "pause-wait-wf",
        on: { "manual.run": {} },
        initial: "wait_child",
        steps: {
          wait_child: step.waitWorkflow({
            workflow: "child-wf",
            outputKey: "k1",
            on: { approved: terminal.done("child_approved") },
          }),
        },
      }),
    );

    const waitCiIR = roundTripIR(
      defineWorkflow({
        id: "pause-wait-ci",
        on: { "manual.run": {} },
        initial: "wait_ci",
        steps: {
          wait_ci: step.integration("acme.wait_ci", {
            input: { repo: "acme/widget", pr_number: 5, head_sha: "sha_p" },
            on: { green: terminal.done("ci_green") },
          }),
        },
      }),
    );

    const gateIR = roundTripIR(
      defineWorkflow({
        id: "pause-gate",
        on: { "manual.run": {} },
        initial: "ask",
        steps: {
          ask: step.gate({
            title: "Approve while paused?",
            choices: [{ id: "ok", label: "OK" }],
            on: { ok: "record" },
          }),
          record: step.integration("acme.close_issue", {
            input: {
              repo: "acme/widget",
              issue_number: 5,
              comment: tpl`choice=${ref("gate.choice")} note=${ref("gate.note")}`,
            },
            on: { closed: terminal.done("gate_done") },
          }),
        },
      }),
    );

    const engine = createWorkflowEngine({
      store: createMemoryWorkflowStore(),
      runner: createFakeAgentRunner(),
      gates,
      integrations: [acme.integration],
      clock,
      workflows: [waitWfIR, waitCiIR, gateIR],
    });

    // 1. wait_workflow output arrives while paused -> stays paused, then completes on resume
    const wfRun = await engine.start({ workflowId: "pause-wait-wf" });
    await engine.pause(wfRun.id);
    const pub = await engine.publishOutput({
      workflowId: "child-wf",
      outputKey: "k1",
      payload: { verdict: "approved" },
    });
    expect(pub.resumedRuns).toHaveLength(0);
    expect((await engine.getRun(wfRun.id))?.status).toBe("paused");
    const wfResumed = await engine.resume(wfRun.id);
    expect(wfResumed.status).toBe("done");
    expect(wfResumed.terminalReason).toBe("child_approved");

    // 2. Integration wait event arrives while paused -> stays paused, then completes on resume
    const ciRun = await engine.start({ workflowId: "pause-wait-ci" });
    await engine.pause(ciRun.id);
    const ciIngest = await engine.ingest(
      makeEvent("acme.ci_status", {
        repo: "acme/widget",
        pr_number: 5,
        head_sha: "sha_p",
        state: "green",
      }),
    );
    expect(ciIngest.resumedRuns).toHaveLength(0);
    expect((await engine.getRun(ciRun.id))?.status).toBe("paused");
    const ciResumed = await engine.resume(ciRun.id);
    expect(ciResumed.status).toBe("done");
    expect(ciResumed.terminalReason).toBe("ci_green");

    // 3. Gate resolved while paused -> does NOT advance until resume, then runs downstream with gate context
    const gateRun = await engine.start({ workflowId: "pause-gate" });
    await engine.pause(gateRun.id);
    const gateId = gates.opened[0]!.id;
    const afterResolve = await engine.resolveGate(gateId, {
      choice: "ok",
      note: "approved during pause",
      actor: "mo",
    });
    expect(afterResolve.status).toBe("paused");
    expect(acme.closedIssues).toHaveLength(0);

    const gateResumed = await engine.resume(gateRun.id);
    expect(gateResumed.status).toBe("done");
    expect(gateResumed.terminalReason).toBe("gate_done");
    expect(acme.closedIssues).toEqual([
      {
        repo: "acme/widget",
        issue_number: 5,
        comment: "choice=ok note=approved during pause",
      },
    ]);
  });

  it("delivers an ingested event at most once per run with onConflict: signal", async () => {
    const deliveries: string[] = [];
    const countingIntegration: WorkflowIntegration = {
      id: "acme",
      steps: {
        wait_stage: {
          inputSchema: z.object({ stage: z.string(), pr: z.number().int() }),
          outcomes: ["green"],
          async execute(input) {
            return {
              status: "suspended",
              waitKey: `stage:${String(input["stage"])}#${String(input["pr"])}`,
            };
          },
          async onEvent(event, input) {
            deliveries.push(String(input["stage"]));
            if (event.payload["pr"] === input["pr"] && event.payload["state"] === "green") {
              return { status: "completed", outcome: "green" };
            }
            return { status: "still_waiting" };
          },
        },
      },
    };

    const twoStageSignalIR = roundTripIR(
      defineWorkflow({
        id: "acme-two-stage-signal",
        on: { "acme.ci": { connection: "acme-main" } },
        subject: {
          key: tpl`pr#${ref("event.pr")}`,
          onConflict: "signal",
        },
        initial: "first",
        steps: {
          first: step.integration("acme.wait_stage", {
            input: { stage: "first", pr: ref("event.pr") },
            on: { green: "second" },
          }),
          second: step.integration("acme.wait_stage", {
            input: { stage: "second", pr: ref("event.pr") },
            on: { green: terminal.done("both_stages") },
          }),
        },
      }),
    );

    const engine = createWorkflowEngine({
      store: createMemoryWorkflowStore(),
      runner: createFakeAgentRunner(),
      gates: createFakeGateSink(),
      integrations: [countingIntegration],
      clock: createFakeClock(),
      workflows: [twoStageSignalIR],
    });

    // Event 1 opens the run and suspends in `first`.
    const firstIngest = await engine.ingest(makeEvent("acme.ci", { pr: 1, state: "pending" }));
    const runId = firstIngest.matchedRuns[0]!.id;
    expect(firstIngest.matchedRuns[0]?.status).toBe("waiting");
    expect(firstIngest.matchedRuns[0]?.currentState).toBe("first");
    expect(deliveries).toEqual([]);

    // Event 2 (green) satisfies ONLY `first`, leaving the run waiting on `second`.
    const secondIngest = await engine.ingest(makeEvent("acme.ci", { pr: 1, state: "green" }));
    expect(deliveries).toEqual(["first"]);
    expect(secondIngest.resumedRuns).toHaveLength(1);
    const midRun = await engine.getRun(runId);
    expect(midRun?.status).toBe("waiting");
    expect(midRun?.currentState).toBe("second");

    // Event 3 (green) now satisfies `second` and completes the run.
    await engine.ingest(makeEvent("acme.ci", { pr: 1, state: "green" }));
    expect(deliveries).toEqual(["first", "second"]);
    const doneRun = await engine.getRun(runId);
    expect(doneRun?.status).toBe("done");
    expect(doneRun?.terminalReason).toBe("both_stages");
  });
});
