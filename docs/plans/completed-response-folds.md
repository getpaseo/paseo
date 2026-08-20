# Completed response folds

## Goal

Keep completed chats readable by showing the final assistant answer and replacing reasoning, tool
calls, progress messages, tasks, and compaction markers with one disclosure row.

## Context

The timeline is canonical transcript state shared by sync, forking, and provider features. Folding
must therefore be a reversible app presentation, not timeline compaction or persistence mutation.
One visible response can span multiple canonical `turnId` values when its intervening prompts are
system-injected.

## Scope

- Apply the same behavior in the shared Expo stream on native, browser, and Electron.
- Fold only settled visible responses that end with a final assistant message.
- Keep the active response, errors, and still-running tools visible.
- Let the user expand or collapse each response for the lifetime of the open agent view.
- Preserve stable committed-history references while live-head rows stream.

## Non-goals

- Changing provider context, daemon persistence, or the wire protocol.
- Persisting disclosure state between app sessions.
- Inferring a final answer when tool work follows the last assistant message.
- Animating transcript height changes.

## Architecture

An app-only projection partitions the tail and head by visible response boundaries. It removes
foldable rows from the render model, attaches the disclosure to the terminal assistant row, and
leaves the canonical arrays untouched. The terminal assistant item ID is both the stable expansion
key and list anchor, so pagination, virtualization, and native inverted-list behavior keep using real
item identities.

## Validation

- Focused projection tests cover collapse, expansion, active responses, cross-turn responses,
  tail/head boundaries, protected rows, incomplete answers, and live-head reference stability.
- Run app type checking, repository linting, formatting checks, and the i18n resource test.
- Inspect the final diff and test the disclosure manually on desktop and mobile-sized layouts.

## Status

Complete. The shared app projection, disclosure UI, translations, focused tests, type checking,
linting, Electron-targeted web export, and Android JavaScript export are verified.
