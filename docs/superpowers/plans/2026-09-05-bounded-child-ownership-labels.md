# Bounded Child Ownership Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let plugin-created child agents carry bounded labels without allowing plugins to forge parent ownership.

**Architecture:** Extend the optional child-create request with a strict bounded labels map. The plugin SDK and scaffold expose the same type, while the daemon adds a canonical live-caller parent label outside the plugin label cap. The existing standalone authority conformance artifact exercises the full plugin-process-to-daemon path.

**Tech Stack:** TypeScript, Zod, Vitest, esbuild, plugin subprocess IPC, Markdown.

**Spec:** `docs/superpowers/specs/2026-09-05-bounded-child-ownership-labels-design.md`

## Global Constraints

- Plugin-supplied child labels use `MAX_PLUGIN_HOST_CHILD_LABELS` (32); the daemon-owned parent label is outside that cap. Keys use `MAX_PLUGIN_AUTHORITY_LABEL_KEY_BYTES` (128) UTF-8 bytes and values use `MAX_PLUGIN_AUTHORITY_LABEL_VALUE_BYTES` (512) UTF-8 bytes.
- Child label keys use the ASCII-safe pattern and reject reserved namespaces, authority-name segments, and dangerous prototype keys. `subagents.*` is allowed.
- `paseo.parent-agent-id` is daemon-owned and always equals the freshly resolved caller agent ID.
- The new request field is optional for backward compatibility.
- Run only targeted tests; always run typecheck, lint, and format checks after changes.
- Run `npm run format` before committing.

### Task 1: Protocol wire contract

**Files:**

- Modify: `packages/protocol/src/plugin-host.ts`
- Test: `packages/protocol/src/plugin-host.test.ts`

- [x] Add a failing test for valid bounded labels, oversized label maps, oversized UTF-8 keys/values, ASCII-safe keys, and reserved/prototype-key rejection.
- [x] Run `npx vitest run packages/protocol/src/plugin-host.test.ts --bail=1` and confirm the new cases fail because `labels` is not yet in the child request schema.
- [x] Add the optional strict labels record and shared child options schema to `PluginHostChildCreateRequestSchema` using the child-label constants.
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

- [x] Add a failing server assertion that child labels survive creation while the daemon adds canonical parent ownership and rejects reserved labels.
- [x] Run the targeted session test and confirm the child labels are not passed through yet.
- [x] Parse the shared child options schema in the server, add `PARENT_AGENT_ID_LABEL` immediately before `createAgentCommand`, and use the canonical label constant for parentage.
- [x] Run the targeted session test and confirm authority inheritance and label ownership pass.

### Task 4: Documentation and conformance

**Files:**

- Modify: `docs/plugins.md`
- Modify: `public-docs/plugins/reference.md`
- Modify: `packages/server/scripts/plugin-host-authority-conformance.ts`
- Modify: `packages/server/scripts/plugin-host-authority-conformance.test.mjs`
- Modify: `packages/server/scripts/build-plugin-host-conformance.mjs` only if source-manifest inputs require it

- [x] Extend the conformance plugin child call with bounded labels, a count-limit case, and an open-tab spoof case; inspect the created child record's labels.
- [x] Add assertions for requested-label preservation and canonical parent ownership, plus boundary cases in the protocol/scaffold tests.
- [x] Run the conformance executable test and inspect its emitted case output.
- [x] Update both plugin references with the bounded labels, key policy, and reserved namespace rule.

### Task 5: Repository verification and commit

- [x] Run targeted protocol, plugin, CLI scaffold, server session, and conformance tests.
- [x] Run `npm run typecheck` and `npm run lint`.
- [x] Run `npm run format`, then `npm run format:check`.
- [x] Review the diff and amend the exact commit `feat(plugin): allow bounded child ownership labels`.
