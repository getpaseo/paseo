---
name: pandaos-factory
description: Run and track software-factory work through the optional Kitchen plugin, its selected workflow pack, acceptance evidence, and decision trail.
---

# PandaOS factory work

Adapted from the working practices in [Poteto mode](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md). Use the optional [Kitchen plugin](https://github.com/marushan491/paseo-kitchen) through public Paseo plugin APIs. See [the host boundaries](../../docs/team-runtime.md) and the installed plugin's README for configuration. This skill does not install another workflow engine.

## Start from the repository contract

Read the repository's instructions and `.agent-factory/project.json` when present. The selected trusted workflow pack owns roles, phases and acceptance policy. Built-in packs are `kitchen`, `kitchen-insights`, `kitchen-gardener` and `software-basic`. A basic pack does not implement a company's workflow or its approval policy. Native `.pandaos/project.json`, native packs and existing native team jobs are not migrated automatically.

Before starting work, state the observable outcome and evidence that will establish completion. Break a larger goal into independently verifiable items with acceptance criteria, dependencies and file conflicts. Small tasks can stay in one agent.

Open Kitchen from the workspace Explorer, Sidebar or Command Center. From an agent, choose **Hand off to Kitchen** to retain its source link and provider, model, permission mode and thinking settings. Record the returned job identity. Choose a fixed or self-organizing workflow and submit the goal and criteria. Self-organizing workflows accept bounded work requests from authorized roles; fixed workflows reject delegation.

Native `team_start`, `team_report`, `team_status`, `team_message`, `item_*` MCP tools and `pandaos team` CLI commands are unavailable after the native coordinator is removed. Do not instruct a worker to call them. Use the plugin's UI and the report format supplied in the worker's active packet.

## Track the same run

Use Kitchen's persisted job state, board and event log. Do not create another task database or infer a completed phase from an idle agent. Teamchat records human input and sends the actual Boss message. Pause prevents new dispatch while existing turns finish; Stop interrupts managed turns and leaves the job resumable; Cancel closes it. Use the plugin's retry controls for failed decisions. Prefer completion notifications over repeated polling.

Kitchen schedules start the same service with durable request identities. Configure an explicit host home or endpoint and a working public CLI in plugin settings. Use only provider and model IDs advertised by that host. Never substitute another daemon when a configured host cannot be reached.

## Leave evidence and a decision trail

Keep each item small enough to verify before continuing. Fix the shared cause rather than duplicating patches across callers. Reuse existing tools and patterns before adding another abstraction.

Do not add explanatory code comments. Remove them from code you edit and put necessary rationale in the report or owning documentation. Preserve required license notices and tool directives.

A worker finishes with one `factory-report` JSON fence matching its active packet. Required report fields are `outcome` and `summary`. Optional artifacts are objects with `kind`, `ref` and optional `note`; criterion evidence uses `id`, `met` and `evidence`. PO reports may include `items`; authorized self-organizing roles may include `workRequests`. Use the packet's exact enums and schemas. A valid report must match the active binding and phase.

Attach the tested commit, runnable checks, screenshots for UI scenarios and artifact references. Connect every acceptance criterion to its evidence. If a reviewer edits code, verify the resulting commit again before acceptance. A green check on an earlier commit does not verify the final change. Kitchen acceptance checks the actual clean final Git HEAD and records human acceptance; it does not merge into the source branch or deploy.

Put consequential choices and their reasons in the report summary. Label conclusions as verified, inferred or unconfirmed. Record corrections in the company's existing logbook when configured. Do not silently edit workflow rules or verification checks to make an item pass.

## Host and approval boundaries

The plugin does not implement the removed native Jev team-needed classifier or outcome judge. It cannot guarantee a global archive veto, hide native worker tabs or enforce a host-wide per-role tool allowlist. Read-only instructions do not replace provider permissions. Host quotas, model fallback and sandbox policies remain host responsibilities; exact token limits require trustworthy cumulative usage and are unavailable when the public SDK does not expose it.

Company approval gates still apply. Neither this skill nor a successful agent report authorizes a merge, deployment or expansion of credentials. Existing native jobs must remain with their existing coordinator until explicitly finished or canceled; do not relabel their data as plugin jobs.
