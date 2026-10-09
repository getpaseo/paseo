# Product

Paseo is an environment for running, monitoring, and interacting with coding agents across desktop, mobile, web, and the command line.

**Paseo has a lean, opinionated core built to be extended.** It should be easy to start using and leave room for people to build far beyond the default experience.

## Agents are the focus

The central workflow is giving an agent a task, understanding what it is doing, providing direction, and reviewing the result. Files, terminals, diffs, and other supporting tools help you do that.

Paseo should make this workflow coherent across providers and devices. You should be able to use the agent that fits a task and keep working from another device without rebuilding your environment around it.

This is the basis for product decisions. A familiar feature from another development tool earns its place by improving that experience. Familiarity alone does not make it a requirement for Paseo.

## A low floor and a high ceiling

### Easy to start

The default experience should be lean, polished, and understandable to someone who has never run a server or configured a VPN.

With a supported coding agent installed and authenticated, you can open the desktop app and start working. The app manages its local daemon. To connect your phone through the optional Paseo relay, enable pairing and scan a QR code. You do not need to configure a VPN or understand the networking behind it.

You should not need to know that plugins exist to get a useful, complete experience. Extra capability should become discoverable when it helps with something you want to do.

Keeping this starting point approachable is an ongoing responsibility. A technically correct feature can still make the product harder to understand through extra choices, controls, or setup.

### Room to build your own setup

The same product should also work for someone running agents on a home server, using their own network, or building an automated workflow.

The daemon can run independently of the desktop app. Clients connect to it locally or remotely, and multiple clients can use the same daemon. This separation lets you choose where the work runs and how you interact with it.

For example, someone can use the relay to connect their phone with minimal setup. Someone else can run a daemon on their own infrastructure and connect through SSH or a VPN. Both use the same underlying system.

Paseo should provide useful defaults while keeping these choices available. You should not have to adopt every part of the system to benefit from the parts you want.

See the [connectivity guide](https://paseo.sh/docs/connectivity) for supported connection methods and [architecture](architecture.md) for the system design.

## Freedom, ownership, and privacy

Paseo's flexibility depends on keeping control with the user:

- **Self-hosted:** Run agents on your own machines, with your own environment, files, and credentials.
- **Provider choice:** Use supported agent harnesses and extend provider support through plugins. Your workflow should be able to evolve as your choice of provider changes.
- **Cross-device:** Use desktop, mobile, web, and CLI clients according to the situation.
- **Privacy:** No Paseo telemetry, tracking, or forced account. The relay is optional and end-to-end encrypted.
- **Open source:** Paseo is Apache-2.0 licensed. You can inspect it, modify it, and build on it.

Convenience and ownership should work together. Offering a straightforward way to connect should preserve the option to operate your own setup.

## A lean core that keeps improving

The core provides the shared experience: starting work, interacting with agents, understanding their state, and moving between workspaces and devices.

Core development continues through improvements to reliability, performance, interaction design, and workflows with broad value. A lean core takes ongoing work.

Every addition also has a lasting cost. It needs a place in the interface, an understandable relationship with existing behavior, testing across affected platforms, and maintenance as the rest of the product changes. A feature can work exactly as intended and still be the wrong addition.

The preference is for a small number of well-shaped capabilities that work together. Before adding a specialized workflow, consider whether an existing capability can serve it or whether a reusable extension point would let people build it themselves.

The boundary can evolve. Some built-in capabilities may eventually make more sense as plugins. Any such move needs to preserve a coherent default experience and account for people who already depend on it.

## Extensibility and composition

Plugins are a central part of how Paseo gains capability.

Someone who needs a different agent provider, a specialized workspace panel, or a custom command should be able to build and share it independently. They can make the choices that fit their users and maintain the integration on their own schedule.

Paseo's role is to provide interfaces that make those contributions possible across the daemon and connected clients. The [plugin documentation](https://paseo.sh/docs/plugins) describes what each released API supports.

The [SDK](https://paseo.sh/docs/sdk) lets applications and services use the daemon directly. A separate dashboard, automation service, or client can build on the same agent infrastructure. Those projects do not all need to become features of the main app.

Composition means useful pieces can be combined in ways the maintainer did not have to predict. Keeping the daemon independent, offering multiple connection methods, and exposing agent operations through APIs gives people room to choose those combinations.

The extension interfaces need the same care as the core experience. They should be understandable, reusable, and maintainable. New extension points should follow concrete workflows that need them.

## How Paseo develops

Product, design, architecture, and workflow decisions remain with the maintainer.

Those decisions draw on the history of the product: why a workflow has its current shape, what previous approaches taught us, how it interacts with the rest of the system, and where it is intended to go. Documentation shares that context, but familiarity also develops through sustained use and maintenance.

Development starts with the smallest useful change that can make a substantial difference. After shipping it, leave room to learn:

- Can people discover and understand it?
- Does it work well in their actual workflows?
- What friction or missing capability appears with repeated use?
- Does the next addition improve the shared experience or belong in a plugin?

That feedback guides the next step. Expanding a workflow too far before people use it creates commitments that are difficult to reverse. Users build habits and integrations around what ships, so removing features or changing interfaces has a real cost.

Writing an implementation is one part of this process. Product judgment, design, QA, review, and learning from use determine how quickly a change can responsibly become part of Paseo.

## An ecosystem people can build on

People contribute through reproducible bug reports, testing, workflow discussions, documentation, plugins, integrations, and helping each other.

A plugin can solve a problem for its users without adding that workflow to everyone's default experience. An alternative client can explore a different interface while using the same daemon. These projects let people take ownership of the experience they want.

The aim is an ecosystem that can develop independently of the maintainer's ability to review core changes. Its value comes from useful things people build, maintain, and share.

Paseo is an independent project. Sustainable development, a coherent product, and the freedom to keep building are priorities. See [Contributing](../CONTRIBUTING.md) for how to participate.
