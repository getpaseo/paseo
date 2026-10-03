# Kitchen Studio plugin

[Kitchen Studio](https://github.com/marushan491/paseo-kitchen) is the public Apache-2.0 plugin
combining the software factory, live Kitchen and mission dashboard. Install this one plugin;
the separate private Dashboard repository is no longer the Studio entry point.

| Owner              | State and responsibilities                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kitchen plugin     | Missions, work items, dependencies, conflicts, role bindings, decisions, workflow packs, dispatch and recovery, verification evidence, acceptance, Kitchen schedules and dashboard preferences. |
| Paseo/PandaOS host | Projects, workspaces, ordinary agents, rich conversations, timeline persistence, history, attachments, permissions, provider/model configuration and actual provider usage.                     |

Kitchen keeps its runtime and UI in the plugin. The host's execution-mode extension returns an
ordinary Head Chef agent; Cook agents also remain ordinary host agents. No Core Kitchen session
entity or native team coordinator is required.

Install a trusted checkout with `pandaos plugin install /absolute/path/to/paseo-kitchen`, or the
equivalent `paseo plugin install`. Enable it on the selected host and configure
**Settings → Connection & capacity**. Storage and CLI operations must target that same host;
Kitchen does not silently use another daemon. See [plugins.md](plugins.md) for installation and
the [Kitchen README](https://github.com/marushan491/paseo-kitchen#install-and-configure) for its
settings, trusted checks and operator credentials.

## Navigation

Open **Kitchen Studio** from the Sidebar or a host-scoped Command Center. Overview, Kitchen,
Missions, Team and Settings share its project scope. Overview shows actual Kitchen questions,
permissions, blocked work and acceptance requests; unrelated chats and ordinary completed Cook
turns do not become human handoffs. Kitchen schedules stay in the plugin; unrelated host cron
schedules remain in the host's Schedules screen.

**Start mission** opens normal New workspace with Kitchen selected. Choose the project and team
preset, write or attach the brief and send. Stay in the ordinary Head Chef conversation. Its
persisted mission card opens the same mission in Studio; follow-ups add context or answer its
current question without creating another mission. Standard team uses independent verification
and explicit acceptance. Basic team uses its lighter declared path. The selected pack and saved
team revision determine execution; the visualization does not introduce extra runtime phases.

Native entry requires app execution contributions and navigation, the daemon's accepted-message
lifecycle carrying the rich prompt, trusted creation-hook origin and persistent plugin timeline
annotations. See
[workspace execution modes](plugins.md#workspace-execution-modes) and the
[lifecycle reference](../public-docs/plugins/reference.md#lifecycle-hooks). Current PandaOS
provides these generic capabilities. Published Paseo `0.11.0-beta.3` lacks the native execution and
accepted-message APIs. A compatible fork can provide them without embedding Kitchen's runtime.
Older hosts show an update requirement for native entry; existing Studio missions and supported
structured CLI/RPC paths remain separate from that capability.

Command Center contributions require a host-scoped page or selected workspace; on `/open-project`,
use the Sidebar. The host keeps ordinary workspace navigation and settings. Disable or remove
Kitchen to remove its contributions.

## Existing native teams

The host advertises `teams: false`; team operations belong to the plugin's contracts and standalone
CLI/MCP bridge. [Wire compatibility](protocol-compatibility.md) does not start a legacy native job
in the plugin.

Use **Settings → Migration** to inspect an explicitly configured local daemon home. Kitchen
backs up selected compatible sources and can import closed native jobs as read-only history,
validated `.pandaos/project.json` role profiles and trusted packs. Active jobs are preserved and
skipped; imported history does not infer acceptance or resume execution. Finish or stop an active
legacy job with its original compatible daemon before replacing that daemon. Incompatible formats
remain unavailable, and imported executable packs require validation on reload.

Kitchen owns optional Jev System One execution classification, natural-language team previews,
ordinary-chat team suggestions and required outcome judging when configured. These decisions use
the configured external service and are distinct from the host's Auto model routing. Native team
selection and explicit structured Single/Team execution do not require a classification request.
Independent repository checks and acceptance requirements still apply; a semantic judgment cannot
authorize missing evidence. Configure decision-service use and exclusions in the
[Kitchen README](https://github.com/marushan491/paseo-kitchen#jev-and-trusted-verification).

## Host boundaries

Factory reports and answers enter persisted plugin contracts; active binding identity and phase
govern which role may advance work or request additional tasks. Trusted creation-hook origin lets
Kitchen reject a native Head Chef's unmanaged agent starts while allowing its own Factory SDK
dispatch. Labels and client-supplied identifiers do not confer that origin. The plugin's role bridge
scopes managed requests. It cannot replace the host's full MCP catalog, veto every archive action or
enforce a host-wide tool allowlist. OS sandboxing, provider quotas and unrelated agent spawns remain
host responsibilities.

Verification and approval use one plugin-owned mission state. Ordinary chat transport origin does
not prove a separate human identity and does not authorize final acceptance or irreversible
actions. Operator credentials, trusted checks and explicit acceptance are configured in the plugin;
acceptance does not merge or deploy.

Dashboard snoozes and Done/Reopen overrides belong to plugin preferences. They do not archive
agents or replace mission acceptance or the host's workspace completion mark. Import existing
device-local snoozes explicitly in **Settings → Dashboard**. Provider/model choices, permission
requests and measured usage remain authoritative host snapshots.
