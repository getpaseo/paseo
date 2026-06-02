# Full Client UI I18n Design

## Goal

Extend the existing Paseo app i18n foundation from the Settings -> General slice to the rest of the client-owned UI, using English and Simplified Chinese resources while keeping daemon, agent, terminal, file path, provider, model, and user-authored text untouched.

## Scope

This is a staged migration, not a single all-at-once rewrite. The first implementation batch covers high-reuse app chrome and shared UI copy so later surfaces can reuse stable common keys.

Batch 1 covers:

- App shell and navigation copy
- Shared headers and sheet/modal chrome
- Common local actions and accessibility labels
- Command center labels and empty/loading states
- Download/toast status copy that is owned by the client
- Existing Settings copy already migrated in the first i18n PR, plus any shared keys needed to avoid duplication

Batch 1 does not cover:

- Composer and agent controls
- Agent stream permission prompts and plan approval UI
- Project settings
- Host settings and provider diagnostics
- Import-session flows
- File explorer, terminal panels, setup panels, and browser/file panels

Those surfaces are later batches because each has enough local state, dynamic labels, and tests to deserve its own focused pass.

## Translation Rules

Use the existing rules in `docs/i18n.md`:

- Translate client-owned UI copy: labels, buttons, empty states, confirmation text, and local status/error wrappers.
- Do not translate agent output, daemon output, terminal contents, file paths, provider names, model names, command names, user-authored text, code blocks, logs, or raw protocol/server error text.

Glossary product terms stay consistent with `docs/glossary.md`. Product terms such as `Agent`, `Provider`, `Model`, `Terminal`, `Host`, `Daemon`, `Project`, and `Workspace` remain recognizable and should not be replaced with novel synonyms.

## Architecture

Keep the current i18n architecture:

- `packages/app/src/i18n/resources/en.ts` is the English source resource.
- `packages/app/src/i18n/resources/zh-CN.ts` mirrors the same keys.
- `packages/app/src/i18n/resources.test.ts` enforces key parity.
- React surfaces use `useTranslation()` and pass translated strings into lower-level UI primitives.

Resource keys are grouped by product surface and reusable common concepts:

```ts
export const en = {
  common: {
    actions: {
      back: "Back",
      cancel: "Cancel",
      close: "Close",
      dismiss: "Dismiss",
      retry: "Retry",
      search: "Search",
    },
    states: {
      loading: "Loading...",
      starting: "Starting...",
      unknownError: "Unknown error",
    },
  },
  shell: {
    menu: {
      open: "Open menu",
      close: "Close menu",
      toggleSidebar: "Toggle sidebar",
    },
    commandCenter: {
      placeholder: "Type a command or search agents...",
      newAgent: "New agent",
    },
  },
} as const;
```

Do not invent a second translation API, central string registry, or runtime extraction step.

## Batch 1 Migration Targets

Batch 1 should migrate complete local copy clusters in these areas:

- `packages/app/src/components/adaptive-modal-sheet.tsx`
  - Back, Close, Search, Dismiss, and related accessibility labels.
- `packages/app/src/components/headers/back-header.tsx`
  - Back accessibility label.
- `packages/app/src/components/headers/menu-header.tsx`
  - Toggle sidebar, Open menu, Close menu.
- `packages/app/src/components/command-center.tsx`
  - New agent fallback label.
  - Search/command placeholder.
- `packages/app/src/components/download-toast.tsx`
  - Starting, Download complete, Download failed fallback.
- Shared local strings used by Settings or shell that currently duplicate existing resource values.

The implementation may skip non-user-facing invariant messages, test fixtures, render profiler labels, static provider/model labels, keyboard key names, and raw error details.

## Later Batches

Batch 2: Composer and agent workflow

- Composer input placeholder and toolbar labels
- Provider/model control labels that are not provider/model names
- Agent panel connection states
- Permission prompt wrapper labels and buttons
- Plan approval UI copy

Batch 3: Settings expansion

- Appearance
- Shortcuts
- Integrations
- Permissions
- Diagnostics
- About
- Project settings
- Host settings
- Provider diagnostics

Batch 4: Workspace and panels

- Workspace setup panel local status labels
- File/browser/terminal panel wrapper copy
- File explorer empty/loading wrapper copy
- Import session flows
- Remaining local toast/error wrapper text

Each later batch should have its own implementation plan and commit series.

## Testing

Batch 1 verification should include:

- `packages/app/src/i18n/resources.test.ts` for English/Chinese key parity.
- Focused unit tests when a migrated non-component helper returns UI strings.
- Existing E2E tests updated only when they assert migrated copy.
- One targeted Playwright smoke test only if a migrated shell flow is not already covered by the existing Settings language selector E2E.

Do not run the full local test suite. Follow `docs/testing.md` and run changed or directly relevant test files only.

## Documentation

Update `docs/i18n.md` after Batch 1 with the staged migration order and any new conventions learned while migrating shared shell copy.

## Open Constraints

The existing PR was created from a fork and upstream GitHub Actions currently require maintainer approval. Local verification remains necessary until upstream CI runs.

The current local install lacks npm `.bin` links for some tools because dependencies were installed with `--no-bin-links`. Verification plans should list npm scripts first and include package-entrypoint fallbacks only when local scripts fail for that environment-specific reason.
