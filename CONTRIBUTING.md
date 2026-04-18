# Contributing to Paseo

Thanks for taking the time to contribute.

## How this project works

Paseo is a BDFL project. Product direction, scope, and what ships are the maintainer's call.

This means:

- PRs submitted without prior discussion will likely be rejected, heavily modified, or scoped down.
- The maintainer may rewrite, split, cherry-pick from, or close any PR at their discretion.
- There is no obligation to merge a PR as-submitted, regardless of code quality.

This is not meant to discourage contributions. It is meant to set clear expectations so nobody wastes their time.

## How to contribute

1. **Open an issue first.** Describe the problem or improvement. Get a thumbs up before writing code.
2. **Keep it small.** One bug, one flow, one focused change.
3. **Open a PR** once there is alignment on scope.

If you want to propose a direction change, start a conversation.

## Before you start

Please read these first:

- [README.md](README.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md)
- [docs/TESTING.md](docs/TESTING.md)
- [CLAUDE.md](CLAUDE.md)

## What is most helpful

The most useful contributions right now are:

- bug fixes
- windows and linux specific fixes
- regression fixes
- doc improvements
- packaging / platform fixes
- focused UX improvements that fit the existing product direction
- tests that lock down important behavior

## Scope expectations

Please keep PRs narrow.

Good:

- fix one bug
- improve one flow
- add one focused panel or command
- tighten one piece of UI

Bad:

- combine multiple product ideas in one PR
- bundle unrelated refactors with a feature
- sneak in roadmap decisions

If a contribution contains multiple ideas, split it up.

## Product fit matters

Paseo is an opinionated product.

When reviewing contributions, the bar is not just:

- is this useful?
- is this well implemented?

It is also:

- does this fit Paseo?
- does this add product surface that will be hard to maintain?
- does the value justify the maintenance surface it adds?
- does this solve a common need or over-serve an edge case?
- does this preserve the product's current direction?

## Development setup

### Prerequisites

- Node.js matching `.tool-versions`
- npm workspaces

### Start local development

```bash
# runs both daemon and expo app
npm run dev
```

Useful commands:

```bash
npm run dev:server
npm run dev:app
npm run dev:desktop
npm run dev:website
npm run cli -- ls -a -g
```

Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for build-sync gotchas, local state, ports, and daemon details.

## Multi-platform testing

Paseo ships to mobile (iOS/Android), web, and desktop (Electron). Every UI change must be tested on mobile and web at minimum, and desktop if relevant. Things that look fine on one surface regularly break on another.

Common checks:

```bash
npm run typecheck
npm run test --workspaces --if-present
```

Important rules:

- always run `npm run typecheck` after changes
- tests should be deterministic
- prefer real dependencies over mocks when possible
- do not make breaking WebSocket / protocol changes
- app and daemon versions in the wild lag each other, so compatibility matters

If you touch protocol or shared client/server behavior, read the compatibility notes in [CLAUDE.md](CLAUDE.md).

## Coding standards

Paseo has explicit standards. Follow them.

The full guide lives in [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md).

## PR checklist

Before opening a PR, make sure:

- there was prior discussion and alignment on scope (issue or conversation)
- the change is focused, one idea per PR
- the PR description explains what changed and why
- **UI changes include screenshots or videos** for every affected platform (mobile, web, desktop)
- UI changes have been tested on mobile and web at minimum
- typecheck passes
- tests pass, or you clearly explain what could not be run
- relevant docs were updated if needed

## Communication

If you are unsure whether something fits, ask first.

That is especially true for:

- new core UX
- naming / terminology changes
- new extension points
- new orchestration models
- anything that would be hard to remove later

Early alignment saves everyone time.

## Forks are fine

If you want to explore a different product direction, a fork is completely fine.

Paseo is open source on purpose. Not every idea needs to land in the main repo to be valuable.
