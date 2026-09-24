# Session and script-health CI triage

Scope: incoming base `160430f94`, CI candidate `d7c07411e` (run 35973248754), current candidate `fb4f42001`. Inspected the 23 failures in `src/server/session.test.ts` and one failure in `src/server/script-health-monitor.test.ts` only. Current candidate has identical affected production/test content to the CI candidate. No repository edits or tests were run in this triage; existing CI logs provide failing execution evidence. This record does not close findings or supersede the orchestrator status ledger.

## CI-SESSION-01: The session fixture prevents 23 metadata-generation tests from reaching the generator

Guarantee: commit and PR generation tests must exercise the production prompt builder, configuration overrides, generated schema, and structured-generation fallback. Basis: the existing test assertions. The CI failure prevents those guarantees being verified; it does not demonstrate broken generation for real users.

At `packages/server/src/server/session.test.ts:381`, `createSessionForTest` supplies an AgentManager stub without `backgroundActivity`. `asAgentManager` in `packages/server/src/server/test-utils/session-stubs.ts:28` only wraps provided fields. The Proxy in `class-mocks.ts:37` returns a throwing function for unspecified properties. `createAgentStructuredTextGeneration` at `session/checkout/git-metadata-generator.ts:186` reads that property and invokes `activity.create(...)`; the returned function has no `.create`, so generation fails before the mocked `generateStructuredAgentResponseWithFallback` can execute. Checkout catches this exception and emits an error response (`checkout-session.ts:770` and `:985`). This explains the mock call count of zero, undefined prompts/schema, and missing commit/createPullRequest fallback calls across all 23 tests.

Counterexample to a production defect: real `AgentManager` always initializes `readonly backgroundActivity = new BackgroundActivityRecorder()` at `agent/agent-manager.ts:709`. The recorder supplies both `.create` and `.finish`. The production generator, failing session tests, and stub wrapper have no diff between incoming base and current HEAD. Background bookkeeping was introduced by `fe676b131` (Add background activity inspection and plan handoff actions); `git merge-base --is-ancestor fe676b131 160430f94` exits 0. Thus this mismatch is already in incoming base, not introduced by chapter freshness or this merge.

Minimal correction: import `BackgroundActivityRecorder` into `session.test.ts`, and add `backgroundActivity: new BackgroundActivityRecorder()` to its local default AgentManager fixture before `...options.agentManager`. Keep the existing structured-response mock, assertions, and fallback checks. No production change or shared mock overhaul is needed. A real recorder preserves its method contract without duplicating it.

Rating: S2/F0 → P2, confidence 100, developer-only. F0 applies to these tests whenever they use generated text. Merge gate: blocks a claim of green server CI / verified metadata regression coverage; no supported production defect established. Status: open, test-adapter correction proposed.

## CI-SCRIPT-01: The health test terminal fixture lacks script activity support

Guarantee: a plain script must run without adding a proxy route while a service script registers a route and receives health probes. Basis: `script-health-monitor.test.ts:422` existing integration-style test.

`createStubTerminalManager` at `script-health-monitor.test.ts:54` returns a terminal without `.setActivity`. `spawnWorkspaceScript` calls it at `worktree-bootstrap.ts:1071` for every plain script before sending the command; CI records `TypeError: terminal.setActivity is not a function`. The test exits before its routing/health assertions.

Counterexample to a production defect: `TerminalSession` declares this required method (`terminal/terminal.ts:93`), the real terminal implements it (`:1440`, returned at `:1553`), and the worker-backed terminal implements it (`terminal/worker-terminal-manager.ts:323`). The caller and missing fixture method already exist in incoming `160430f94`. The calls were added in `41b31a3dd` (Add package.json script discovery and execution); its ancestor check against incoming base exits 0. Feature-side bootstrap changes add logger propagation and early-exit handling; they do not introduce this method call.

Minimal correction: add `setActivity: () => {}` to the terminal object returned by this test's local stub. Activity itself is not this test's subject, so a no-op is sufficient and retains the route assertions. No production guard or broader mock modernization is justified.

Rating: S2/F0 → P2, confidence 100, developer-only. F0 applies to this health test's plain-script launch. Merge gate: blocks a claim of green server CI / verified route-health coverage; no supported production defect established. Status: open, test-adapter correction proposed.

## Proposed verification (not executed)

From `packages/server`, run only the changed test files, sequentially:

```sh
npx vitest run src/server/session.test.ts --bail=1
npx vitest run src/server/script-health-monitor.test.ts --bail=1
```

These cover all 23 metadata assertions and the route-health integration assertion plus their sibling scenarios. To observe a single original symptom before a fix, use `-t "generates commit messages from checkout diffs"` for session.test.ts or `-t "only probes service routes"` for script-health-monitor.test.ts. Check error response capture if further diagnosis is needed; the zero-call assertions are downstream of the fixture exception. Run repository-required typecheck and lint after implementing corrections. No full local suite is necessary.
