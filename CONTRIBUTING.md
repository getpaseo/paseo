# Contributing to Paseo

Thanks for taking the time to contribute.

## How this project works

Paseo is opinionated, and it's a one-person project. I read every issue and PR myself, so the cost of reviewing a contribution is real.

That shapes what does and doesn't work here:

- **Feature requests are welcome.** Open an issue describing the problem you're hitting. I take that input seriously, and a lot of what's in Paseo today came from someone explaining their pain in a thread.
- **Drive-by feature PRs without a prior issue are not.** A large over-indexed feature that solves one person's edge case is the exact thing that holds the product back, and saying no after the code is written is expensive for both of us. Open the issue first, get a thumbs up on the shape, then write the code.
- **Objective bug fixes don't need a prior issue.** If something is provably broken and your PR fixes it without dragging in unrelated changes, just open it.
- The product stays lean. I'll close, scope down, or rewrite PRs that add surface area I don't want to maintain, even if the code is fine.
- I may rewrite, split, cherry-pick from, or close any PR at my discretion. There's no obligation to merge as-submitted.

This isn't meant to discourage you. If you've taken the time to write up a problem clearly, that already puts you ahead.

## How to contribute

1. **For features or behavior changes: open an issue first.** Describe the problem and the proposed change. Get a thumbs up before writing code. PRs that try to land a feature without an issue are the most common reason a contribution gets rejected.
2. **For objective bug fixes: just open the PR.** Reference the bug, keep the diff narrow, and show that you tested it. No prior issue needed if the bug is clear.
3. **Keep it small.** One bug, one flow, one focused change.

If you want to propose a direction change, start a conversation in [Discord](https://discord.gg/jz8T2uahpH) before opening anything.

## Reporting issues

The bug report form asks for the surface, version, provider configuration, logs, and screenshots. Fill it in. Most of my time on a bad report goes into asking back for what should already be in the issue.

A few things that make reports useful:

- **Full logs, not AI summaries.** Using an agent to grab the relevant log section is fine. Submitting only the agent's _interpretation_ of the log is not. Agents routinely correlate adjacent log lines as cause-and-effect when they aren't, and once a report is filtered through that, the signal I need to fix the bug is gone. Paste the raw log.
- **Use agents for information gathering, not diagnosis.** An agent that grabs the daemon log, the version, and the OS for you is helpful. An agent that submits its own theory of the bug is noise 99% of the time.
- **Screenshots and videos for UI bugs.** Text descriptions of UI bugs lose detail. A 10-second screen recording is worth a paragraph.
- **One bug per issue.** If you found three things, open three issues.

## Before you start

Please read these first:

- [README.md](README.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/development.md](docs/development.md)
- [docs/coding-standards.md](docs/coding-standards.md)
- [docs/testing.md](docs/testing.md)
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

Read [docs/development.md](docs/development.md) for build-sync gotchas, local state, ports, and daemon details.

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

The full guide lives in [docs/coding-standards.md](docs/coding-standards.md).

## PR checklist

Before opening a PR, make sure:

- there was prior discussion and alignment on scope (issue or conversation), unless it's an objective bug fix
- the change is focused, one idea per PR
- the PR description explains what changed and why, in your own words
- **UI changes include screenshots or videos** for every affected platform (mobile, web, desktop)
- UI changes have been tested on mobile and web at minimum
- typecheck passes
- tests pass, or you clearly explain what could not be run
- relevant docs were updated if needed

The PR template applies whether you opened the PR through the web UI or `gh pr create`. Don't strip it out.

## On AI-assisted contributions

AI is fine. I use it. The bar isn't whether AI helped you write the code or the description, the bar is whether _you_ tested it and understand why it works.

What that looks like in practice:

- **Verification is the section I read most carefully.** "I ran X, observed Y" with a screenshot or a log snippet beats any amount of plausible-looking prose.
- **A wall of confident AI-generated description with no evidence of testing is a red flag.** It often means the PR was generated end-to-end and never run. If that's what I'm seeing, I'll usually close.
- **If you don't understand why your change works, say so.** I'd rather see "I'm not sure why this fixes it but here's the repro before and after" than a fabricated explanation.

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
