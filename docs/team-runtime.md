# Kitchen and Dashboard plugins

PandaOS extensions use public Paseo plugin APIs. Install Kitchen and Dashboard separately; the host does not bundle their workflow state or UI.

| Extension | Repository                                                                    | Owns                                                                                                                          |
| --------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Kitchen   | [marushan491/paseo-kitchen](https://github.com/marushan491/paseo-kitchen)     | teams, work-item dependencies, role dispatch, separate worktrees, reviewed commits, acceptance evidence, team chat, schedules |
| Dashboard | [marushan491/paseo-dashboard](https://github.com/marushan491/paseo-dashboard) | Inbox, project boards, snoozes, schedule failures, handoff hints                                                              |

Kitchen is an Apache-2.0 open-source repository. Dashboard remains private. Install each checkout with `pandaos plugin install /absolute/path/to/plugin`. Configure each plugin using its settings screen and README. Plugins support original Paseo and PandaOS; see [plugins.md](plugins.md) for host installation.

## Navigation

Kitchen and Dashboard register their own Sidebar entries and Command Center commands. Command Center contributions require a host-scoped page or selected workspace; on `/open-project`, use the Sidebar. The host keeps ordinary workspace navigation and settings. Old `/teams` and `/dashboard` URLs redirect to the project picker; choose the installed plugin from the Sidebar. Disable or remove a plugin to remove its contributions.

## Existing native teams

The native coordinator and `team_*`/`item_*` MCP tools are removed. The host advertises `teams: false`. Legacy Team WebSocket messages remain parseable and return `unsupported_feature`; protocol schemas remain backward-compatible.

Kitchen has its own storage, contracts and agent labels. It does not import native `teams/` state, `.pandaos/project.json` profiles, native packs or `team_report` reports. Preserve native data and finish active native jobs with their existing daemon before changing that daemon. Do not start an old native run in Kitchen as if it were the same job.

The removed native Jev team-needed classifier and outcome judge are not implemented by Kitchen. Kitchen uses its selected workflow pack and actual repository checks. A custom trusted plugin pack can supply a company workflow; selecting the basic software pack does not claim company-policy equivalence.

## Host boundaries

Ordinary agents, workspace completion marks, permission checks, provider/model routing and host quotas remain Core capabilities. Plugins cannot guarantee a global archive veto or a per-role host-wide tool allowlist. Keep required host-wide constraints in the host.

Dashboard uses public snapshots and the public CLI for schedule inspection and actions. Plugin snoozes and Dashboard completion overrides are stored by the plugin. They are separate from the host's workspace completion mark. Existing device-local snoozes require an explicit import in plugin settings; shared workspace `doneAt` and handoff metadata are read from public snapshots when supplied by the host.
