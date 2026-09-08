# Contributing to Paseo

Thank you for taking the time to contribute to Paseo.

## Philosophy

Paseo is an opinionated product, built on freedom and flexibility: any agent provider, any device, running on your own machine. It is meant to be composable, so you can build the workflow you want. Read more about the product vision [here](docs/product.md).

Given Paseo's scope, contributing to it takes a lot of context that is very hard to transfer. That's why product, design, architecture, and workflow decisions are currently all made by the maintainer.

I pick what to build based on whether it fits the product, how many workflows it improves, whether it keeps things composable, whether we can hold the quality bar, and whether I want to build it.

## Report bugs in GitHub issues or Discord

Open an [issue](https://github.com/getpaseo/paseo/issues) or post in [Discord](https://discord.gg/jz8T2uahpH).

> [!IMPORTANT]
> Feature requests opened as issues will get closed automatically

If you used an agent to investigate, paste the raw evidence and repro steps it collected, not its diagnosis.

You may submit a PR to fix a bug, please read the PR guidelines below.

## Product discussions go in GitHub Discussions or Discord

There's no feature request backlog. Open a product discussion in [Discussions](https://github.com/getpaseo/paseo/discussions) or `#product` in [Discord](https://discord.gg/jz8T2uahpH), and frame it as a workflow:

- What are you trying to do?
- How do you do it today?
- Where does Paseo get in the way?
- What would the flow look like if it worked for you?

"Can you build X" is not useful because it doesn't tell me about your problem.

A discussion also lets other people add their own version of the same problem, and that's what I read when I decide what to build.

Due to the volume and my limited bandwidth, I may not participate in all the discussions, if something gains interest it will make it's way to me.

## Pull requests

For plugin changes, start with the [SDK import boundaries](docs/plugins.md#sdk-import-boundaries).

Anyone can open a pull request, but there are no guarantees of it getting merged, only submit one if you're okay with it being closed.

Open it as a draft if the work isn't ready for review, if you want to run the checks against it, or if you want feedback on the direction before you finish it. Mark it ready when you want it looked at.

Here is the criteria I use to decide:

✅ Likely to be accepted

- Fits the product vision
- One focused change
- Links the bug it fixes, or the discussion behind it if there is one
- Addresses bot reviews
- Explains the problem you're solving
- QA evidence
- Automated tests
- Screenshots or video for UI changes, on every affected platform
- Says which platforms you tested and which you didn't
- Maintainer edits enabled

⛔️ Will be rejected

- Bundles unrelated changes
- Fails checks
- Ignores bot reviews
- Takes a feature or the design in a direction I don't want
- No QA evidence
- No tests
- Clearly fully AI-generated PR

### What to expect

- PRs that were explicitly approved in a discussion are preferred.
- Unsolicited PR can be closed without a detailed review.
- Your PR can be narrowed, refactored, or redesigned.
- Your PR might be accepted but not merged immediately.
- You will be attributed for your work in the changelog, even if I redesign your PR

## QA evidence

QA is the main bottleneck of Paseo's product development, and it's not just whether the feature works, it's also whether it meets the quality bar.

Pull requests without evidence will be closed.

What's accepted:

- The shell commands you ran, pasted with their output
- The tests you added and their results
- Before and after screenshots
- A video of the whole interaction
- Logs, requests, responses

Bugs and features both need automated tests, and the tests have to exercise the real thing. UI changes need a video, or a screenshot if it's static.

The [QA guide](docs/qa.md) covers what to check for each of these and the tooling to do it.

## I want to become a maintainer

There's no formal process to become a maintainer, just consistently get involved with the project by answering questions, testing, reproducing bugs, discussing workflows with the community and offer to implement features when we reach an agreement.

## FAQ

### I'm blocked, where do I go?

Join [Discord](https://discord.gg/jz8T2uahpH), ask your questions there.

### Do you prefer Github or Discord?

I am more active on Discord for general questions.

I prefer Github for bugs because the template helps collect information more efficiently.

### Why was my feature request closed?

Issues are only for bugs. Open it as a product discussion instead, framed as a workflow.

### Why didn't my PR get a detailed review?

Writing a review is very time consuming and Paseo receives a lot of PRs, I cannot give detailed explanations at volume.

### How long until someone looks at my pull request?

It depends on what else is going on. QA takes longer than reading the diff. You are welcome to join Discord to ask.

### Why do you want tests and a video for a small change?

Because it's faster and safer than me checking out and running every PR myself to test it manually.

QA evidence help me take your PR seriously for a deeper review and maintainer QA.

### I only have one platform, can I still contribute?

Yes. Test what you have, and say what you didn't test.

### Can I use an agent to write my contribution?

Yes, as long as you understand what you're submitting and you tested it yourself.

### Is there a roadmap I can read?

[docs/product.md](docs/product.md) covers the direction. There's no public list of what I'm building next.
