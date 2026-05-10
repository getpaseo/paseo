# Contributing to Paseo

## How this project works

Paseo is opinionated and maintained by one person. I read every issue and PR myself, so review cost is real.

- **Feature requests are welcome.** Open an issue describing the problem. Get a thumbs up before writing code. Big ideas are better discussed in [Discord](https://discord.gg/jz8T2uahpH) first.
- **Objective bug fixes don't need a prior issue.** Reference what's broken, keep the diff narrow, open the PR.
- **The product stays lean.** I'll close, scope down, or rewrite PRs that add surface area I don't want to maintain, even if the code is fine.

## Reporting bugs

Fill in the bug report form. The fields are there because asking back for the surface, version, provider config, and logs is where most of my time on a bad report goes.

- **Full logs, not AI summaries.** Use an agent to grab the relevant log section if you want, but paste the raw log. Agents routinely correlate adjacent lines as cause-and-effect when they aren't, and once a report is filtered through that the signal I need is gone.
- **Agents for information gathering, not diagnosis.** A bot that grabs your daemon log, version, and OS is helpful. A bot that submits its own theory of the bug is noise 99% of the time.
- **Screenshots or video for UI bugs.** A 10-second recording beats a paragraph.
- **One bug per issue.** Three findings, three issues.

## Before you start

- [README.md](README.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/development.md](docs/development.md)
- [docs/coding-standards.md](docs/coding-standards.md)
- [docs/testing.md](docs/testing.md)
- [CLAUDE.md](CLAUDE.md)

## What is most helpful

- bug fixes (especially Windows and Linux)
- regression fixes
- doc improvements
- packaging and platform fixes
- focused UX improvements that fit the product direction
- tests that lock down important behavior

## Development setup

```bash
npm run dev               # daemon + expo
npm run dev:server
npm run dev:app
npm run dev:desktop
npm run dev:website
```

[docs/development.md](docs/development.md) covers build sync, local state, and ports. Coding rules live in [docs/coding-standards.md](docs/coding-standards.md).

## Pull requests

- One focused change per PR. Split unrelated cleanups out.
- Reference the issue you're fixing, unless it's a small objective bug.
- UI changes need screenshots or video on every affected platform (mobile, web, desktop). Things that look fine on one surface regularly break on another.
- `npm run typecheck` and `npm run lint` must pass.
- Don't make breaking WebSocket or protocol changes. Old apps and old daemons coexist in the wild.
- The PR template applies whether you used the web UI or `gh pr create`. Don't strip it out.

**On AI-assisted PRs.** AI in the loop is fine. The bar is whether _you_ tested the change and can explain why it works. A confident wall of AI prose with no evidence of testing is a red flag and usually gets closed. If you don't fully understand why your fix works, say so directly. "Here's the repro before and after, not sure why this fixes it" is much better than a fabricated explanation.

## Forks are fine

If you want to explore a different product direction, fork. Paseo is open source on purpose. Not every idea needs to land here to be valuable.
