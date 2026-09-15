# Handoff Execution Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify every final structured plan and launch its executor with a server-validated Codex model and thinking effort, without requiring a Router conversation or saved executor profile.

**Architecture:** Add one strict routing-policy module, persist one classifier state per plan, and reuse the existing agent SDK to create, wait for, and archive a technical classifier. The workflow then launches the executor with direct settings while retaining the existing plan admission, idempotency, handoff briefing, and final-review lifecycle.

**Tech Stack:** TypeScript, Zod, Paseo plugin SDK, Vitest, Playwright, Electron packaging.

**Spec:** `docs/superpowers/specs/2026-09-15-handoff-execution-routing-design.md`

## Global Constraints

- Classify the exact final plan for Router, Planner, and ordinary conversations.
- Do not depend on saved profiles for classifier or executor launch.
- Use only the five Codex model/effort rows in the approved policy.
- Persist the validated decision before closing the source plan.
- Reuse accepted classifier and executor requests after retries or reconnects.
- Never trust model or effort values supplied by the app client.
- Keep failure visible and the plan actionable; do not silently fall back.
- Add no public protocol or migration.
- Preserve the automatic final-review workflow for direct-config executors.
- Do not restart the main daemon on port 6767 without explicit permission.
- Do not commit, push, or create a PR without explicit user authorization.

---

### Task 1: Strict execution-routing policy

**Files:**

- Create: `plugins/paseo-workflow/server/execution-routing.ts`
- Create: `plugins/paseo-workflow/server/execution-routing.test.ts`

**Interfaces:**

- Produces: `ExecutionCategory`, `ExecutionDecision`, `executionDecision`, `executionOutputSchema`, `executionRoutingPrompt(briefing: string)`, and `parseExecutionDecision(text)`.
- Consumes: `decisionJson(text)` from `plugins/paseo-workflow/shared/decisions.ts`.

- [ ] **Step 1: Write the failing policy test**

Cover every allowed row and reject a model/effort pair that does not exactly match its category:

```ts
import { describe, expect, test } from "vitest";
import { parseExecutionDecision, routes } from "./execution-routing";

describe("execution routing policy", () => {
  test.each(routes)("accepts $category as $model/$effort", (route) => {
    expect(
      parseExecutionDecision(
        JSON.stringify({ ...route, provider: "codex", reason: `Matched ${route.category}` }),
      ),
    ).toEqual({ ...route, provider: "codex", reason: `Matched ${route.category}` });
  });

  test("rejects a combination outside its policy row", () => {
    expect(() =>
      parseExecutionDecision(
        JSON.stringify({
          category: "bounded",
          provider: "codex",
          model: "gpt-6-astra",
          effort: "xhigh",
          reason: "Invented combination",
        }),
      ),
    ).toThrow("routing policy");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run plugins/paseo-workflow/server/execution-routing.test.ts --bail=1`

Expected: FAIL because `execution-routing.ts` does not exist.

- [ ] **Step 3: Implement the policy and strict parser**

Use one readonly table as the source of truth. The model output must repeat the selected row, and the parser must verify it:

```ts
import { z } from "zod";
import { decisionJson } from "../shared/decisions";

export const routes = [
  { category: "trivial", model: "gpt-5.6-luna", effort: "low" },
  { category: "bounded", model: "gpt-5.6-sol", effort: "medium" },
  { category: "diagnostic", model: "gpt-5.6-sol", effort: "high" },
  { category: "complex", model: "gpt-6-astra", effort: "high" },
  { category: "critical", model: "gpt-6-astra", effort: "xhigh" },
] as const;

export type ExecutionCategory = (typeof routes)[number]["category"];
export const executionDecision = z.object({
  category: z.enum(["trivial", "bounded", "diagnostic", "complex", "critical"]),
  provider: z.literal("codex"),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh"]),
  reason: z.string().trim().min(1),
});
export type ExecutionDecision = z.infer<typeof executionDecision>;
export const executionOutputSchema = z.toJSONSchema(executionDecision);

export function parseExecutionDecision(text: string): ExecutionDecision {
  const decision = executionDecision.parse(decisionJson(text));
  const route = routes.find((entry) => entry.category === decision.category)!;
  if (decision.model !== route.model || decision.effort !== route.effort)
    throw new Error("The classifier returned a combination outside the routing policy.");
  return decision;
}
```

Build `executionRoutingPrompt(briefing: string)` from the approved table and explicit precedence rules: risk beats size, uncertainty raises the category, and only one complete JSON object is allowed. Append the already serialized workflow briefing without reparsing it.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npx vitest run plugins/paseo-workflow/server/execution-routing.test.ts --bail=1`

Expected: 2 tests plus five table cases PASS.

---

### Task 2: Persist and resume classifier state

**Files:**

- Modify: `plugins/paseo-workflow/server/state.ts`
- Modify: `plugins/paseo-workflow/server/workflow.ts`
- Modify: `plugins/paseo-workflow/server/workflow.test.ts`
- Modify: `plugins/paseo-workflow/server/types.ts`

**Interfaces:**

- Consumes: `ExecutionDecision`, `executionOutputSchema`, `executionRoutingPrompt()`, and `parseExecutionDecision()` from Task 1.
- Produces: optional `plan.routing`, `WorkflowPort.models()`, `WorkflowPort.wait()`, and `WorkflowPort.archive()` contracts used by Task 3.

- [ ] **Step 1: Write a failing direct-plan routing test**

Extend the workflow fixture with model discovery, wait results, and archived IDs. Assert that an ordinary plan creates one classifier before closing the plan:

```ts
test("an ordinary plan classifies once before it closes or launches an executor", async () => {
  const f = fixture();
  f.useOrdinaryPlan();
  f.completeClassifier({
    category: "diagnostic",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    reason: "Several modules require diagnosis",
  });

  const result = await new WorkflowController(f.port).handoff(f.ordinaryPlan);

  expect(result).toEqual({ agentId: "child-2" });
  expect(f.launches[0]).toMatchObject({
    workspaceId: "workspace",
    parent: "ordinary",
    idempotencyKey: "workflow:ordinary:handoff:ordinary-plan:classifier:1",
    config: {
      provider: "codex/gpt-5.6-sol",
      thinkingOptionId: "medium",
      writePolicy: "read_only",
    },
  });
  expect(f.decisions).toEqual(["ordinary-permission"]);
  expect(
    (await f.port.read()).workflows.ordinary.plans["ordinary-plan"].routing?.decision,
  ).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
});
```

- [ ] **Step 2: Run the workflow test and verify RED**

Run: `npx vitest run plugins/paseo-workflow/server/workflow.test.ts --bail=1`

Expected: FAIL because `handoff()` still requires a Standard/Advanced selection and has no routing state.

- [ ] **Step 3: Add backward-compatible stored routing state**

Add this optional object beside `handoff` in both the Zod settings schema and `Workflow` type:

```ts
routing: z
  .object({
    attempt: z.number().int().positive(),
    phase: z.enum(["running", "complete", "failed", "outcome_unknown"]),
    agentId: z.string().optional(),
    decision: executionDecision.optional(),
    error: z.string().optional(),
  })
  .optional(),
```

Keep the existing handoff `selection` readable for in-flight stored workflows. Mark that compatibility branch with `COMPAT(workflow-executor-selection)` and do not write it for new handoffs.

- [ ] **Step 4: Add the minimal port contracts**

Make `WorkflowLaunch.launchProfileId` optional and add the existing SDK operations needed by the controller:

```ts
models(provider: string, cwd: string): Promise<
  Array<{ id: string; thinkingOptions?: Array<{ id: string }> }>
>;
wait(agentId: string, timeoutMs: number): Promise<{
  status: string;
  error?: string | null;
  lastMessage?: string | null;
}>;
archive(agentId: string): Promise<void>;
```

Extend `WorkflowLaunch` with optional `prompt`, `clientMessageId`, and `outputSchema` so classifier creation can atomically include its first prompt.

- [ ] **Step 5: Implement `routeExecution()` inside `WorkflowController`**

The method must:

1. Return a persisted complete decision immediately.
2. Resume `wait()` for a running or outcome-unknown classifier.
3. Increment `attempt` only after a definitive failed result.
4. Validate classifier availability before creation.
5. Persist its agent ID before waiting.
6. Parse and validate the completed result, persist it, then archive the classifier.
7. Leave timeout/outcome-unknown state recoverable and turn malformed output into a retryable failed state.

Create the classifier with these direct settings:

```ts
{
  workspaceId: workflow.workspaceId,
  parent: plan.context.agentId,
  idempotencyKey: `workflow:${workflow.id}:handoff:${plan.context.callId}:classifier:${attempt}`,
  config: {
    provider: "codex/gpt-5.6-sol",
    modeId: "auto",
    thinkingOptionId: "medium",
    writePolicy: "read_only",
  },
  prompt: executionRoutingPrompt(briefing(workflow, plan.context.text)),
  clientMessageId: `workflow:${workflow.id}:handoff:${plan.context.callId}:classifier:${attempt}:prompt`,
  outputSchema: executionOutputSchema,
  labels: {
    "paseo.workflow.id": workflow.id,
    "paseo.workflow.plan": plan.context.callId,
    "paseo.workflow.role": "execution-router",
  },
}
```

- [ ] **Step 6: Add failure and reconnection tests one cycle at a time**

Add and run each test before implementing its branch:

- malformed JSON leaves the permission pending and marks routing failed;
- unsupported model/effort leaves the permission pending;
- timeout retains the same classifier ID and retry waits for it again;
- two concurrent handoff calls create one classifier;
- a persisted complete decision never calls the classifier again.

Run after each slice: `npx vitest run plugins/paseo-workflow/server/workflow.test.ts --bail=1`

Expected: every new case PASS before starting the next.

---

### Task 3: Launch direct-config executors and preserve final review

**Files:**

- Modify: `plugins/paseo-workflow/server/workflow.ts`
- Modify: `plugins/paseo-workflow/server/runtime.ts`
- Modify: `plugins/paseo-workflow/index.server.ts`
- Modify: `plugins/paseo-workflow/server/runtime.test.ts`
- Modify: `plugins/paseo-workflow/server/workflow.test.ts`
- Modify: `packages/server/src/server/plugins/workflow.e2e.test.ts`

**Interfaces:**

- Consumes: persisted `ExecutionDecision` and expanded `WorkflowPort` from Task 2.
- Produces: automatic `handoff(context)` that returns the direct-config executor ID.

- [ ] **Step 1: Write the failing executor-launch test**

Replace the old Standard/Advanced assertion with the exact routed settings:

```ts
expect(f.launches[1]).toMatchObject({
  workspaceId: "workspace",
  idempotencyKey: "workflow:planner:handoff:plan-1",
  config: {
    provider: "codex/gpt-6-astra",
    modeId: "auto",
    thinkingOptionId: "xhigh",
    writePolicy: "read_write",
  },
  labels: {
    "paseo.workflow.id": "planner",
    "paseo.workflow.plan": "plan-1",
    "paseo.workflow.role": "executor-critical",
  },
});
expect(f.launches[1]).not.toHaveProperty("launchProfileId");
```

- [ ] **Step 2: Run the workflow test and verify RED**

Run: `npx vitest run plugins/paseo-workflow/server/workflow.test.ts --bail=1`

Expected: FAIL because executor launch still resolves an executor profile.

- [ ] **Step 3: Replace profile selection with the persisted decision**

Change `handoff(context, selected?)` to `handoff(context)`. Call `routeExecution()` before responding to the source permission. Build executor config directly from `decision.provider`, `decision.model`, and `decision.effort`. Keep the existing executor idempotency key and handoff prompt ID unchanged.

Use `executor-${decision.category}` as the workflow role label and include the routed decision in the handoff marker. Preserve the old stored-selection resume branch only for a handoff that had already closed before this version.

- [ ] **Step 4: Implement the SDK adapter methods**

In `runtime.ts`:

```ts
models: async (provider, cwd) => {
  const result = await paseo.providers.listModels(provider, { cwd });
  if (result.error) throw new Error(result.error);
  return result.models ?? [];
},
wait: async (id, timeoutMs) => paseo.agents.ref(id).waitForFinish(timeoutMs),
archive: async (id) => {
  await paseo.agents.ref(id).archive();
},
```

Pass `prompt`, `clientMessageId`, and `outputSchema` through the existing `create` adapter. Validate both the classifier combination and the selected executor combination against each model's `thinkingOptions` before launch.

- [ ] **Step 5: Preserve completion handling for direct executors**

In `index.server.ts`, admit completed turns when either the launch profile is a workflow profile or the trusted workflow label is one of `executor-trivial`, `executor-bounded`, `executor-diagnostic`, `executor-complex`, or `executor-critical`. Exclude `execution-router`, whose result is consumed synchronously by `routeExecution()`.

Add a workflow test proving `turnEnded()` starts final review for a direct-config executor carrying the workflow ID, plan ID, and executor role labels.

- [ ] **Step 6: Update the real-daemon workflow test**

Change the ordinary-plan E2E fixture so its fake Codex provider returns a valid classifier decision, then assert:

- one classifier is created with direct Sol/medium settings;
- one executor is created with the routed model/effort and no launch profile;
- classifier and executor prompts are each delivered once across plugin reload;
- the classifier is archived;
- the executor still enters the existing final-review lifecycle after completion.

Run: `npx vitest run packages/server/src/server/plugins/workflow.e2e.test.ts --bail=1`

Expected: the targeted file PASS without a real model request.

---

### Task 4: Make Handoff automatic and delete the dropdown path

**Files:**

- Modify: `plugins/paseo-workflow/shared/rpc.ts`
- Modify: `plugins/paseo-workflow/client/actions.ts`
- Modify: `plugins/paseo-workflow/client/actions.test.ts`
- Modify: `packages/plugin/src/client/contracts.ts`
- Modify: `packages/plugin/src/client/index.ts`
- Modify: `packages/app/src/plugins/plan-actions/model.ts`
- Modify: `packages/app/src/plugins/plan-actions/model.test.ts`
- Modify: `packages/app/src/plugins/plan-actions/view.tsx`

**Interfaces:**

- Consumes: automatic server `handoff(context)` from Task 3.
- Produces: one direct Handoff action with existing pending/error rendering and executor navigation.

- [ ] **Step 1: Write the failing client-action test**

Assert one RPC and no choice list:

```ts
expect(actions[1]?.choices).toBeUndefined();
await actions[1]!.onPress(context);
expect(calls).toEqual([
  { rpc: "workflow.plan.handoff.request", input: expectedPlanContext },
  { agentId: "executor" },
]);
```

- [ ] **Step 2: Run the client test and verify RED**

Run: `npx vitest run plugins/paseo-workflow/client/actions.test.ts --bail=1`

Expected: FAIL because the client still prepares a recommendation and sends `selection`.

- [ ] **Step 3: Make the RPC server-owned**

Make `selection` optional in `handoffRpc` only as a temporary input compatibility field and ignore it server-side. Remove the prepare call and choice argument from the client action:

```ts
const { agentId } = await context.rpc(handoffRpc, planInput(context));
context.navigation?.openAgent({ agentId });
```

Keep `prepareRpc` readable during the compatibility window because an already-loaded older client contribution may invoke it. Tag both compatibility sites with `COMPAT(workflow-automatic-routing)` and a removal date.

- [ ] **Step 4: Delete the now-unused generic choice API**

Remove `PluginPlanActionChoice`, `choices`, the second `onPress` argument, `PlanAction.choices`, `shouldOverflow()`, `PlanActionChoiceControl`, and the dropdown trigger branch. Restore ordinary compact overflow behavior.

Update `model.test.ts` to assert that Handoff is a normal action for every launch profile and moves into compact overflow. Do not retain the dropdown as speculative plugin API.

- [ ] **Step 5: Run client and app unit tests**

Run:

```bash
npx vitest run plugins/paseo-workflow/client/actions.test.ts packages/app/src/plugins/plan-actions/model.test.ts --bail=1
```

Expected: both files PASS.

- [ ] **Step 6: Verify existing pending and failure UI behavior**

The generic plan-action state already owns pending locks and rendered retryable errors. Run its existing browser contract unchanged:

```bash
npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/plan-actions.spec.ts
```

Expected: Handoff is locked during another remote action, errors remain visible, and compact overflow remains usable.

---

### Task 5: Documentation, build, and packaged-app verification

**Files:**

- Modify: `docs/plugins.md`
- Verify: all files changed in Tasks 1–4

**Interfaces:**

- Consumes: completed automatic routing behavior.
- Produces: current documentation and release-quality local evidence.

- [ ] **Step 1: Update the owning documentation**

Rewrite the first-party workflow paragraph in `docs/plugins.md`. State that Handoff classifies the exact final plan, launches with direct model/effort settings, does not require a Router conversation or saved executor profiles, and retains the early Router recommendation only as context. Remove the Standard/Advanced profile-selection wording.

- [ ] **Step 2: Run formatting and focused static checks**

Run:

```bash
npm run format
npm run format:check
npm run lint -- plugins/paseo-workflow packages/plugin/src/client packages/app/src/plugins/plan-actions packages/app/src/plugins/actions.ts packages/app/src/plugins/navigation.ts packages/server/src/server/plugins/workflow.e2e.test.ts
git diff --check
```

Expected: all commands exit 0 with no warnings or whitespace errors.

- [ ] **Step 3: Rebuild dependency declarations before final typechecks**

Run:

```bash
npm run build:client
npm run build:server
npm run typecheck --workspace=@getpaseo/plugin
npm run typecheck --prefix plugins/paseo-workflow
npm run typecheck --workspace=@getpaseo/app
```

Expected: all commands exit 0.

- [ ] **Step 4: Re-run only the changed targeted tests**

Run:

```bash
npx vitest run plugins/paseo-workflow/server/execution-routing.test.ts plugins/paseo-workflow/server/workflow.test.ts plugins/paseo-workflow/server/runtime.test.ts plugins/paseo-workflow/client/actions.test.ts packages/app/src/plugins/plan-actions/model.test.ts packages/server/src/server/plugins/workflow.e2e.test.ts --bail=1
```

Expected: every listed file PASS. Do not run the full repository suite locally.

- [ ] **Step 5: Build and install the desktop app**

Run: `npm run build`

Expected: the signed application is installed at `/Users/sylvaindivito/Applications/Paseo Local.app`.

Verify:

```bash
codesign --verify --deep --strict "/Users/sylvaindivito/Applications/Paseo Local.app"
open "/Users/sylvaindivito/Applications/Paseo Local.app"
lsof -nP -iTCP:6767 -sTCP:LISTEN
```

Expected: signature verification and app launch succeed; the existing daemon PID remains listening and is not restarted by a verification command.

- [ ] **Step 6: Verify the UI flow**

Start with `agent-browser` against the isolated test surface. Create a direct ordinary structured plan, press Handoff once, verify the pending label, and confirm the routed executor opens with the expected runtime model and effort. Capture the screenshot and console.

If `agent-browser` cannot resolve the native `paseo://` surface, record that failure and use the native computer-control fallback. Do not create a real provider turn merely to manufacture visual evidence when the isolated fake-provider E2E already proves routing.

- [ ] **Step 7: Report without publishing**

Report the exact tests, typechecks, build, signature, plugin status, app launch, UI evidence, and any unverified limitation. Leave all changes uncommitted until the user explicitly authorizes commit, push, or PR creation.
