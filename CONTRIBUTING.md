# Contributing to Paseo

Paseo is an opinionated product maintained by one person right now.

The product covers a lot of surface: mobile, desktop, web, the daemon, the relay, and both self-hosted and hosted setups.

Contributing takes a lot of context that is very hard to transfer. That's why product, design, architecture, and workflow decisions are currently all made by the maintainer.

## Becoming a maintainer

There's no formal process to become a maintainer, if you consistently contribute and help out, you'll become one.

Here's the progression:

1. Get involved in the community: answer questions in Discord and on GitHub
2. Triage bugs: replicate and help fix them
3. Work on maintainer-approved features

The reason for this progression is so that you can gain all the context you need to take on more responsibility, so that I can see if you have what it takes to be a maintainer.

Learning on the job is fine, I do not care how many years of experience you have, what I care about is that you get the vision and want to contribute.

## Pull requests

✅ Will be accepted

- Keep it to one focused change
- Link to an issue
- Explain the problem you're solving
- Include repro steps if it's a bug
- Include QA/testing evidence
- UI changes need screenshots or video for every affected platform: iOS, Android, desktop, and web
- If you only tested one platform, say that clearly

⛔️ Will be rejected

- Bundle unrelated changes
- Fail basic checks like typecheck, formatting or linting
- Add a feature or design change that wasn't discussed first
- Submit no evidence of testing
- Skip the linked issue
- Clearly fully AI-generated PR

## Requesting features

If you need a feature implemented, create a Github issue or a thread in Discord.

Explain the problem you want to solve: your use case, where Paseo falls short today, and the flow you expect.

## AI assistance

Using AI to help write code is fine, but you must:

- Ensure your agents read the docs
- Understand the code you submit
- Review and test the code yourself
