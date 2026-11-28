import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTrigger, defineWorkflow, expr, ref, step, terminal, tpl } from "../src/dsl.js";
import { validateWorkflowIR, type WorkflowIR } from "../src/ir.js";
import { compileWorkflowYaml } from "../src/yaml.js";

describe("DSL and YAML byte-identical IR compilation", () => {
  it("compiles 1-state trigger shorthand identically from TS DSL and YAML", () => {
    const yamlSource = `
name: acme-priority-review
enabled: true
on:
  acme.pull_request_label_added:
    connection: acme-main
    filters:
      repo: acme/widget
      label: priority-review
max_runtime: 1h
run:
  target:
    daemon: factory
    cwd: /srv/acme/widget
    worktree:
      mode: branch-off
      base: origin/main
      newBranch: priority-review-\${{ paseo.execution.id }}
  agent:
    provider: claude
    model: claude-opus-5-5
    mode: bypassPermissions
    thinkingOptionId: medium
  continuation:
    mode: new
  max_runtime: 30m
  idle_timeout: 10m
  auto_archive: true
  background: true
  acme:
    connection: acme-main
    repositories: [acme/widget]
    permissions:
      contents: read
      pull_requests: write
  prompt: "Review priority PR #\${{ paseo.context.acme.item.number }}."
  outputs:
    acme.reply:
      max: 3
`;

    const dslIR = defineTrigger({
      name: "acme-priority-review",
      enabled: true,
      on: {
        "acme.pull_request_label_added": {
          connection: "acme-main",
          filters: { repo: "acme/widget", label: "priority-review" },
        },
      },
      maxRuntime: "1h",
      run: {
        target: {
          daemon: "factory",
          cwd: "/srv/acme/widget",
          worktree: {
            mode: "branch-off",
            base: "origin/main",
            newBranch: tpl`priority-review-${expr.executionId()}`,
          },
        },
        agent: {
          provider: "claude",
          model: "claude-opus-5-5",
          mode: "bypassPermissions",
          thinkingOptionId: "medium",
        },
        continuation: { mode: "new" },
        maxRuntime: "30m",
        idleTimeout: "10m",
        autoArchive: true,
        background: true,
        auth: {
          acme: {
            connection: "acme-main",
            repositories: ["acme/widget"],
            permissions: { contents: "read", pull_requests: "write" },
          },
        },
        prompt: tpl`Review priority PR #${ref("event.acme.item.number")}.`,
        outputs: {
          "acme.reply": { max: 3 },
        },
      },
    });

    const yamlIR = compileWorkflowYaml(yamlSource);

    expect(JSON.stringify(dslIR)).toBe(JSON.stringify(yamlIR));
    expect(JSON.parse(JSON.stringify(yamlIR))).toEqual(yamlIR);
    expect(yamlIR.initial).toBe("run");
    expect(Object.keys(yamlIR.states)).toEqual(["run"]);
    expect(yamlIR.states["run"]?.kind).toBe("agent");
  });

  it("compiles a full multi-step workflow with Zod schemas, integration waits, wait.workflow, gates, and sleep identically", () => {
    const FixOutputSchema = z.object({
      outcome: z.enum(["pr_ready", "needs_maintainer"]),
      pr_number: z.number(),
      head_sha: z.string(),
    });

    const dslIR = defineWorkflow({
      id: "acme-issue-to-pr",
      on: {
        "acme.issue_created": {
          connection: "acme-main",
          filters: { repo: "acme/widget" },
        },
      },
      subject: {
        key: tpl`${ref("event.acme.repo")}#${ref("event.acme.issue_number")}`,
        onConflict: "ignore",
      },
      initial: "fix",
      steps: {
        fix: step.agent({
          maxLoops: 3,
          prompt: tpl`Fix #${ref("event.acme.issue_number")}.`,
          auth: { acme: { connection: "acme-main", scope: "write" } },
          output: FixOutputSchema,
          on: {
            pr_ready: "wait_ci",
            needs_maintainer: "maintainer_gate",
            max_loops_exceeded: "maintainer_gate",
          },
        }),
        wait_ci: step.integration("acme.wait_ci", {
          input: {
            repo: "acme/widget",
            pr_number: ref("steps.fix.outputs.pr_number"),
            head_sha: ref("steps.fix.outputs.head_sha"),
          },
          timeout: "90m",
          on: {
            green: "wait_review",
            red: "fix",
            timeout: "maintainer_gate",
          },
        }),
        wait_review: step.waitWorkflow({
          workflow: "acme-review",
          outputKey: tpl`review:acme/widget#${ref("steps.fix.outputs.pr_number")}@${ref("steps.fix.outputs.head_sha")}`,
          dispatchIfMissing: true,
          inputs: {
            pr_number: ref("steps.fix.outputs.pr_number"),
            head_sha: ref("steps.fix.outputs.head_sha"),
          },
          timeout: "1h",
          on: {
            approved: "cooldown",
            changes_requested: "fix",
            timeout: "maintainer_gate",
          },
        }),
        cooldown: step.sleep({
          duration: "5m",
          on: { done: "merge" },
        }),
        maintainer_gate: step.gate({
          title: tpl`Decision needed on #${ref("event.acme.issue_number")}`,
          summary: expr.coalesce(ref("steps.wait_review.outputs.reason"), "manual review"),
          recommended: "rework",
          choices: [
            { id: "merge_anyway", label: "Merge anyway" },
            { id: "rework", label: "Rework", description: "Try fix again" },
          ],
          timeout: "14d",
          onTimeout: terminal.cancelled("gate_expired"),
          on: {
            merge_anyway: "merge",
            rework: "fix",
          },
        }),
        merge: step.integration("acme.merge_pr", {
          auth: { acme: { connection: "acme-main", scope: "write" } },
          input: {
            pr_number: ref("steps.fix.outputs.pr_number"),
            note: expr.coalesce(ref("gate.note"), "auto-merged"),
          },
          on: {
            merged: terminal.done(),
            conflict: "fix",
          },
        }),
      },
      publish: {
        key: tpl`issue:acme/widget#${ref("event.acme.issue_number")}`,
        payload: {
          pr_number: ref("steps.fix.outputs.pr_number"),
          head_sha: ref("steps.fix.outputs.head_sha"),
        },
      },
    });

    const yamlSource = `
id: acme-issue-to-pr
on:
  acme.issue_created:
    connection: acme-main
    filters:
      repo: acme/widget
subject:
  key: "{{ event.acme.repo }}#{{ event.acme.issue_number }}"
  on_conflict: ignore
initial: fix
states:
  fix:
    kind: agent
    max_loops: 3
    prompt: "Fix #{{ event.acme.issue_number }}."
    auth:
      acme:
        connection: acme-main
        scope: write
    output:
      schema:
        type: object
        properties:
          outcome:
            type: string
            enum: [pr_ready, needs_maintainer]
          pr_number:
            type: number
          head_sha:
            type: string
        required: [outcome, pr_number, head_sha]
        additionalProperties: false
    on:
      pr_ready: wait_ci
      needs_maintainer: maintainer_gate
      max_loops_exceeded: maintainer_gate
  wait_ci:
    kind: acme.wait_ci
    input:
      repo: acme/widget
      pr_number: "{{ steps.fix.outputs.pr_number }}"
      head_sha: "{{ steps.fix.outputs.head_sha }}"
    timeout: 90m
    on:
      green: wait_review
      red: fix
      timeout: maintainer_gate
  wait_review:
    kind: wait.workflow
    workflow: acme-review
    output_key: "review:acme/widget#{{ steps.fix.outputs.pr_number }}@{{ steps.fix.outputs.head_sha }}"
    dispatch_if_missing: true
    inputs:
      pr_number: "{{ steps.fix.outputs.pr_number }}"
      head_sha: "{{ steps.fix.outputs.head_sha }}"
    timeout: 1h
    on:
      approved: cooldown
      changes_requested: fix
      timeout: maintainer_gate
  cooldown:
    kind: sleep
    duration: 5m
    on:
      done: merge
  maintainer_gate:
    kind: gate
    title: "Decision needed on #{{ event.acme.issue_number }}"
    summary: "{{ steps.wait_review.outputs.reason ?? 'manual review' }}"
    recommended: rework
    choices:
      - { id: merge_anyway, label: Merge anyway }
      - { id: rework, label: Rework, description: Try fix again }
    timeout: 14d
    on_timeout:
      terminal: cancelled
      reason: gate_expired
    on:
      merge_anyway: merge
      rework: fix
  merge:
    kind: acme.merge_pr
    auth:
      acme:
        connection: acme-main
        scope: write
    input:
      pr_number: "{{ steps.fix.outputs.pr_number }}"
      note: "{{ gate.note ?? 'auto-merged' }}"
    on:
      merged: done
      conflict: fix
publish:
  key: "issue:acme/widget#{{ event.acme.issue_number }}"
  payload:
    pr_number: "{{ steps.fix.outputs.pr_number }}"
    head_sha: "{{ steps.fix.outputs.head_sha }}"
`;

    const yamlIR = compileWorkflowYaml(yamlSource);

    expect(JSON.stringify(dslIR)).toBe(JSON.stringify(yamlIR));
    expect(validateWorkflowIR(JSON.parse(JSON.stringify(dslIR)) as WorkflowIR)).toEqual(dslIR);
  });

  it("compiles scheduled 1-state trigger shorthand with recurrence unchanged", () => {
    const scheduledYaml = `
name: acme-scheduled-sweep
enabled: false
on:
  manual.run: {}
  schedule.tick:
    recurrence:
      start: "2026-10-13T12:20:00"
      rule: "FREQ=HOURLY;INTERVAL=2;BYMINUTE=20;BYSECOND=0"
      timezone: "Europe/Berlin"
run:
  target:
    daemon: factory
    cwd: /srv/acme/bot
  agent:
    provider: codex
    model: gpt-6.1-terra
    mode: full-access
    thinkingOptionId: medium
  continuation:
    mode: new
  max_runtime: 40m
  idle_timeout: 10m
  auto_archive: true
  background: true
  acme:
    connection: acme-main
    repositories: [acme/widget]
    permissions:
      issues: write
    duration: 1h
  prompt: |
    Run sweep.
    \${{ paseo.prompt }}
`;
    const ir = compileWorkflowYaml(scheduledYaml);
    expect(ir.id).toBe("acme-scheduled-sweep");
    expect(ir.enabled).toBe(false);
    expect(ir.initial).toBe("run");
    expect(ir.on["schedule.tick"]?.recurrence?.rule).toContain("FREQ=HOURLY");
    const runStep = ir.states["run"];
    expect(runStep?.kind).toBe("agent");
    if (runStep?.kind === "agent") {
      expect(runStep.auth?.["acme"]?.connection).toBe("acme-main");
    }
  });

  it("compiles ALL 19 real factory trigger YAML files in ~/dev/skills/hub/.paseo/triggers/ read-only when present", () => {
    const triggersDir = path.join(homedir(), "dev", "skills", "hub", ".paseo", "triggers");
    if (!existsSync(triggersDir)) {
      return;
    }

    const files = readdirSync(triggersDir)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort();

    expect(files.length).toBeGreaterThanOrEqual(19);

    for (const file of files) {
      const source = readFileSync(path.join(triggersDir, file), "utf8");
      const ir = compileWorkflowYaml(source);
      const roundTripped = JSON.parse(JSON.stringify(ir)) as WorkflowIR;
      validateWorkflowIR(roundTripped);

      expect(roundTripped.version, file).toBe(1);
      expect(roundTripped.id.length, file).toBeGreaterThan(0);
      expect(roundTripped.initial, file).toBe("run");
      expect(Object.keys(roundTripped.states), file).toEqual(["run"]);
      expect(roundTripped.states["run"]?.kind, file).toBe("agent");
    }
  });
});
