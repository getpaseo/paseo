# Bounded Child Ownership Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let plugin-created child agents carry bounded labels without allowing plugins to forge parent ownership.

**Architecture:** Extend the optional child-create request with a strict bounded labels map. The plugin SDK and scaffold expose the same type, while the daemon merges requested labels with a canonical live-caller parent label whose value always wins. The existing standalone authority conformance artifact exercises the full plugin-process-to-daemon path.

**Tech Stack:** TypeScript, Zod, Vitest, esbuild, plugin subprocess IPC, Markdown.

**Spec:** `docs/superpowers/specs/2026-09-05-bounded-child-ownership-labels-design.md`

## Global Constraints

- Plugin-supplied child labels use `MAX_PLUGIN_HOST_CHILD_LABELS` (127); the final child map uses `MAX_PLUGIN_AUTHORITY_LABELS` (128) after daemon-owned parentage is added. Keys and values use `MAX_PLUGIN_AUTHORITY_STRING_BYTES` UTF-8 byte bounds.
- `paseo.parent-agent-id` is daemon-owned and always equals the freshly resolved caller agent ID.
- The new request field is optional for backward compatibility.
- Run only targeted tests; always run typecheck, lint, and format checks after changes.
- Run `npm run format` before committing.

### Task 1: Protocol wire contract

**Files:**

- Modify: `packages/protocol/src/plugin-host.ts`
- Test: `packages/protocol/src/plugin-host.test.ts`

- [x] Add a failing test for valid bounded labels, oversized label maps, oversized UTF-8 keys/values, and reserved-key-shaped input being structurally accepted for server-side ownership replacement.
- [x] Run `npx vitest run packages/protocol/src/plugin-host.test.ts --bail=1` and confirm the new cases fail because `labels` is not yet in the child request schema.
- [x] Add the optional strict labels record to `PluginHostChildCreateRequestSchema` using the existing authority bounds.
- [x] Run the protocol test file and confirm it passes.

### Task 2: Plugin SDK and scaffold

**Files:**

- Modify: `packages/plugin/src/contracts.ts`
- Modify: `packages/cli/src/commands/plugin/scaffold.ts`
- Test: `packages/cli/src/commands/plugin/scaffold.test.ts`

- [x] Add a failing scaffold assertion that generated declarations expose `labels?: Readonly<Record<string, string>>` on `PluginHostChildCreateOptions`.
- [x] Run the targeted scaffold test and confirm the declaration is absent.
- [x] Add the public SDK and scaffold option types without adding client-side policy logic.
- [x] Run the plugin and scaffold tests.

### Task 3: Daemon ownership merge

**Files:**

- Modify: `packages/server/src/server/session.ts`
- Test: `packages/server/src/server/session.test.ts`

- [x] Add a failing server assertion that child labels survive creation while a forged parent label is replaced by the canonical caller label.
- [x] Run the targeted session test and confirm the child labels are not passed through yet.
- [x] Merge options labels with `PARENT_AGENT_ID_LABEL` immediately before `createAgentCommand`, and use the canonical label constant for parentage.
- [x] Run the targeted session test and confirm authority inheritance and label ownership pass.

### Task 4: Documentation and conformance

**Files:**

- Modify: `docs/plugins.md`
- Modify: `public-docs/plugins/reference.md`
- Modify: `packages/server/scripts/plugin-host-authority-conformance.ts`
- Modify: `packages/server/scripts/plugin-host-authority-conformance.test.mjs`
- Modify: `packages/server/scripts/build-plugin-host-conformance.mjs` only if source-manifest inputs require it

- [x] Extend the conformance plugin child call with bounded labels and inspect the created child record's labels.
- [x] Add assertions for requested-label preservation and canonical parent ownership, plus boundary cases in the protocol/scaffold tests.
- [x] Run the conformance executable test and inspect its emitted case output.
- [x] Update both plugin references with the bounded labels and reserved-parent rule.

### Task 5: Repository verification and commit

- [x] Run targeted protocol, plugin, CLI scaffold, server session, and conformance tests.
- [x] Run `npm run typecheck` and `npm run lint`.
- [x] Run `npm run format`, then `npm run format:check`.
- [x] Review the diff and amend the exact commit `feat(plugin): allow bounded child ownership labels`.
