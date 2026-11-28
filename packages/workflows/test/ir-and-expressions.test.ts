import { describe, expect, it } from "vitest";
import { defineWorkflow, expr, ref, step, terminal, tpl } from "../src/dsl.js";
import {
  evaluateExpression,
  evaluateStringExpression,
  parseExpression,
  parseTemplateExpression,
  type ExpressionContext,
} from "../src/internal/expression.js";
import { validateWorkflowIR, WorkflowValidationError, type WorkflowIR } from "../src/ir.js";

const sampleContext: ExpressionContext = {
  event: {
    acme: {
      repo: "acme/widget",
      item: { number: 42 },
    },
  },
  prompt: "Please inspect this issue",
  inputs: { repo: "acme/override", retries: 3 },
  subject: { key: "acme/widget#42", data: { priority: "p0" } },
  steps: {
    reproduce: {
      outcome: "reproduced",
      outputs: { root_cause: "race condition", contributor_pr: null },
      attempts: 1,
    },
    fix: {
      outcome: "pr_ready",
      outputs: { pr_number: 108, head_sha: "abc123" },
      attempts: 2,
    },
  },
  gate: { choice: "rework", note: "add a regression test", actor: "alice" },
  values: {
    active_pr: parseExpression(
      "steps.fix.outputs.pr_number ?? steps.reproduce.outputs.contributor_pr",
    ),
  },
  executionId: "exec_99",
};

describe("expressions and templates", () => {
  it("parses both ${{ ... }} and {{ ... }} to identical ASTs and evaluates all namespaces", () => {
    const dollarAst = parseTemplateExpression(
      "Issue #${{ event.acme.item.number }} ({{ execution.id }})",
    );
    const bareAst = parseTemplateExpression(
      "Issue #{{ event.acme.item.number }} (${{ paseo.execution.id }})",
    );
    const dslAst = tpl`Issue #${ref("event.acme.item.number")} (${expr.executionId()})`;

    expect(JSON.stringify(dollarAst)).toBe(JSON.stringify(bareAst));
    expect(JSON.stringify(dollarAst)).toBe(JSON.stringify(dslAst));

    expect(evaluateStringExpression(dollarAst, sampleContext)).toBe("Issue #42 (exec_99)");
    expect(evaluateExpression(parseExpression("paseo.context.acme.repo"), sampleContext)).toBe(
      "acme/widget",
    );
    expect(evaluateExpression(parseExpression("paseo.inputs.repo"), sampleContext)).toBe(
      "acme/override",
    );
    expect(evaluateExpression(parseExpression("paseo.prompt"), sampleContext)).toBe(
      "Please inspect this issue",
    );
    expect(evaluateExpression(parseExpression("subject.key"), sampleContext)).toBe(
      "acme/widget#42",
    );
    expect(evaluateExpression(parseExpression("subject.data.priority"), sampleContext)).toBe("p0");
    expect(evaluateExpression(parseExpression("steps.fix.attempts"), sampleContext)).toBe(2);
    expect(evaluateExpression(parseExpression("steps.fix.outcome"), sampleContext)).toBe(
      "pr_ready",
    );
    expect(evaluateExpression(parseExpression("gate.note"), sampleContext)).toBe(
      "add a regression test",
    );
    expect(evaluateExpression(parseExpression("values.active_pr"), sampleContext)).toBe(108);
  });

  it("preserves typed non-string values for standalone interpolations", () => {
    const numExpr = parseTemplateExpression("${{ steps.fix.outputs.pr_number }}");
    expect(evaluateExpression(numExpr, sampleContext)).toBe(108);

    const boolExpr = parseTemplateExpression("{{ steps.fix.outcome == 'pr_ready' && !false }}");
    expect(evaluateExpression(boolExpr, sampleContext)).toBe(true);
  });
});

describe("static WorkflowIR validation", () => {
  it("rejects unknown transition target states", () => {
    expect(() =>
      defineWorkflow({
        id: "bad-target",
        on: { "acme.go": {} },
        initial: "first",
        steps: {
          first: step.agent({
            prompt: "hi",
            on: { ok: "does_not_exist" },
          }),
        },
      }),
    ).toThrowError(WorkflowValidationError);
  });

  it("rejects unguarded cycles lacking maxLoops + max_loops_exceeded", () => {
    expect(() =>
      defineWorkflow({
        id: "unguarded-cycle",
        on: { "acme.go": {} },
        initial: "a",
        steps: {
          a: step.agent({ prompt: "a", on: { ok: "b" } }),
          b: step.agent({ prompt: "b", on: { retry: "a", ok: terminal.done() } }),
        },
      }),
    ).toThrowError(/unguarded cycle/i);
  });

  it("rejects cycles with maxLoops set but missing max_loops_exceeded transition", () => {
    expect(() =>
      defineWorkflow({
        id: "missing-exceeded",
        on: { "acme.go": {} },
        initial: "a",
        steps: {
          a: step.agent({ prompt: "a", maxLoops: 3, on: { ok: "b" } }),
          b: step.agent({ prompt: "b", on: { retry: "a", ok: terminal.done() } }),
        },
      }),
    ).toThrowError(/unguarded cycle/i);
  });

  it("accepts cycles guarded by maxLoops + on.max_loops_exceeded", () => {
    const ir = defineWorkflow({
      id: "guarded-cycle",
      on: { "acme.go": {} },
      initial: "a",
      steps: {
        a: step.agent({
          prompt: "a",
          maxLoops: 3,
          on: { ok: "b", max_loops_exceeded: terminal.failed("loop_limit") },
        }),
        b: step.agent({ prompt: "b", on: { retry: "a", ok: terminal.done() } }),
      },
    });
    expect(validateWorkflowIR(JSON.parse(JSON.stringify(ir)))).toEqual(ir);
  });

  it("rejects expressions referencing nonexistent steps", () => {
    expect(() =>
      defineWorkflow({
        id: "bad-step-ref",
        on: { "acme.go": {} },
        initial: "first",
        steps: {
          first: step.agent({
            prompt: tpl`Look at ${ref("steps.ghost.outputs.pr_number")}`,
            on: { ok: terminal.done() },
          }),
        },
      }),
    ).toThrowError(/unknown step "ghost"/i);
  });

  it("rejects invalid gate recommended choice and invalid sleep config", () => {
    expect(() =>
      defineWorkflow({
        id: "bad-gate",
        on: { "acme.go": {} },
        initial: "ask",
        steps: {
          ask: step.gate({
            title: "Decide",
            recommended: "missing",
            choices: [{ id: "yes", label: "Yes" }],
            on: { yes: terminal.done() },
          }),
        },
      }),
    ).toThrowError(/recommended choice "missing"/i);

    const invalidSleep: WorkflowIR = {
      version: 1,
      id: "bad-sleep",
      enabled: true,
      on: { "acme.go": {} },
      initial: "nap",
      states: {
        nap: {
          id: "nap",
          kind: "sleep",
          on: { done: { terminal: "done" } },
        },
      },
    };
    expect(() => validateWorkflowIR(invalidSleep)).toThrowError(
      /exactly one of durationMs or until/i,
    );
  });
});
