# Agent teams

A team is a named set of roles, each mapped to a provider and model. Start a chat with a team and the chat agent is told its roster: which role does what, and the exact `create_agent` parameters for each. It then delegates by role with the `create_agent` and `wait_for_agent` tools it already has. There is no separate orchestration pipeline.

Use a team when you keep telling a chat "use Codex for the code and Claude for the review". Use [Goals](goals.md) when you need guaranteed review, verification, or merge steps.

## Configure

Teams live in the daemon config under `daemon.teams`. Edit them in the app under **Settings → host → Teams**, or edit `$PASEO_HOME/config.json` and run `paseo reload`. Both apply without a daemon restart. The editor shows when the host advertises `server_info.features.agentTeamsConfig`; an older daemon drops `teams` from a config patch, so the app hides the editor there instead of letting a save look successful.

The editor writes the whole `teams` record through the config RPC (`patchConfig({ teams })`), as agent profiles do. Each role picks a provider (then a model and mode from that provider's catalog) or an agent profile, plus the workspace choice (`isolation`). The editor has no control for `thinkingOptionId`: it keeps a stored value until you change the role's provider or model. Fields it does not know are written back unchanged.

```json
{
  "daemon": {
    "agentProfiles": [
      {
        "id": "gemini-research",
        "name": "Gemini researcher",
        "provider": "gemini",
        "notes": "Research and documentation lookups."
      }
    ],
    "teams": {
      "full-stack": {
        "description": "Ship features end to end.",
        "peerMessaging": true,
        "roles": {
          "implementer": {
            "description": "Writes the code and the tests.",
            "provider": "codex",
            "model": "gpt-5.4",
            "modeId": "full-access",
            "isolation": "worktree"
          },
          "reviewer": {
            "description": "Reviews the implementer's diff for bugs.",
            "provider": "claude",
            "model": "opus"
          },
          "researcher": {
            "description": "Reads docs and the web before a design decision.",
            "profile": "Gemini researcher"
          }
        }
      }
    }
  }
}
```

A role names exactly one of:

- `profile` — an [agent profile](glossary.md) id or name. The role uses the profile's provider, model, mode, thinking option and features. `gemini` above is an ACP provider configured as in [custom-providers.md](custom-providers.md#example-google-gemini-cli).
- `provider` — a provider id, with optional `model`, `modeId` and `thinkingOptionId`.

`description` is required; it is what the chat agent reads to pick a role. `peerMessaging` (team-level, default `false`) lets members of one team run message each other; see [Peer messaging](#peer-messaging). `isolation: "worktree"` tells the chat to create a worktree workspace before starting that helper; `"local"` keeps the helper in the chat's workspace.

The config schema rejects a team without roles and a role with both or neither of `profile` and `provider`; a config patch that breaks these rules fails with the schema's message and changes nothing. The wire schema (`packages/protocol/src/agent-team-config.ts`) is structural only and keeps `isolation` a string, so a client keeps parsing a daemon that adds values. A role that names a profile that does not exist does not fail the config load, because agent profiles are edited at runtime: the daemon logs a warning at startup, `agent.teams.list` leaves that team out and reports it in `error`, and creating a chat with that team fails.

## Use

- App: the **Team** selector next to the agent controls in a new chat. It shows only when the host advertises `server_info.features.agentTeams` and defines at least one team. Each team lists its roles as `role (provider/model)`. With a team selected, the list adds a model row per role whose provider lists models; it opens that provider's models, and **Team default** keeps the configured one. The override applies to the chat being created only and is not remembered; switching teams or hosts clears it.
- CLI: `paseo agent teams` lists teams and roles; `paseo run --team <name> "<prompt>"` starts a team chat.
- Client: `DaemonClient.listAgentTeams()` and `createAgent({ team, teamModelOverrides })`. `teamModelOverrides` maps a role name to a model id.

An unknown team, a model override for a role the team does not have, an empty override model, or `teamModelOverrides` without `team` fails creation and no agent is created. The daemon does not check an override against the provider's model list.

## How the roster reaches the agent

The daemon resolves the team when the chat is created, appends the roster to the agent's creation-time system prompt (`AgentSessionConfig.systemPrompt`), and labels the agent `paseo.team=<name>`. The system prompt is persisted with the agent, so the roster survives resume and daemon restarts, and the user's first message is unchanged. The roster builder is `packages/server/src/server/agent/agent-team-roster.ts`.

The roster is frozen at creation, with the request's model overrides applied. A role whose model is overridden loses its configured `thinkingOptionId`, because thinking options belong to a model. Editing the team later does not change chats that already exist.

The roster gives each role's `create_agent` call a `labels: {"paseo.team-role": "<role>"}` entry. The role label is informational: the chat sets it, teammates see it in `list_team_members`, and the app leads a helper's facts line with it in the team chat's subagents track ([agent-lifecycle.md](agent-lifecycle.md#the-subagents-track)).

## Team runs

A team run is the team chat plus every helper created under it. The daemon stamps membership, not the agents: when an agent in a run calls the agent-scoped `create_agent`, the helper gets `paseo.team-run=<team chat's agent id>`, so helpers of helpers join the same run. The team chat is a member through its own `paseo.team` label. The stamping lives in `packages/server/src/server/agent/tools/paseo-tools.ts` (`withDaemonOwnedTeamLabels`).

Agents cannot forge membership. Agent-scoped `create_agent` and `update_agent` refuse every `paseo.*` label except `paseo.team-role` ([agent-lifecycle.md](agent-lifecycle.md#relationships)). Top-level `create_agent` drops `paseo.team` and `paseo.team-run` from `labels`, and top-level `update_agent` refuses them. Changing labels through the app or the WebSocket API is not restricted; those callers are people.

## Peer messaging

With `peerMessaging: true`, members of one team run get two tools. Unlike the roster, the flag is read from the current config on every call, so turning it off stops messaging in runs already under way. The roster tells the chat to brief helpers on them in their `initialPrompt`.

- `list_team_members {}` returns the run's members: `agentId`, `title`, `role`, `provider`, `status`, `isParent` (the caller's own parent), `isSelf`. Archived members are left out.
- `send_team_message { agentId, message }` delivers `message` to another member of the same run, the team chat included. The receiver gets a sender-marked agent message (`Message from <title> (<role>) [agent <id>]:`) through the same path as `send_agent_prompt`: an idle receiver starts a turn, and a mid-turn receiver is steered (or interrupted on providers that cannot steer).

Helpers cannot reach each other with `send_agent_prompt`; it only reaches the caller's own subagents and the agent that created it, and its refusal points team members to `send_team_message`.

`send_team_message` returns `{ outcome, detail }`. `delivered` means the receiver started a turn on the message; `queued` means it joined the receiver's running turn; `failed` carries the reason (a limit, or a delivery error). Neither means the receiver acted on it, and the sender gets no finish notification. A reply arrives as another team message.

The tools refuse, as a tool error: callers outside a team run, a team without `peerMessaging`, unknown agents, agents in another run, the caller itself, archived or closed agents, and an empty message or one over 8000 characters.

Loops are bounded. A sender gets at most 20 team messages per minute, and a run at most 200 in total. Both counters live in daemon memory and reset when the daemon restarts. The limiter is `packages/server/src/server/agent/team-messaging.ts`.

## Limits

- The chat agent decides when and whether to delegate. A team adds instructions, not enforcement.
- Peer messaging only reaches members of the same run. There is no cross-run or cross-team messaging.
- There is no review, verification or merge guarantee. The chat is told it stays responsible for checking and integrating helper results. Use [Goals](goals.md) for enforced gates.
- Helpers a team chat creates do not inherit the team, its roster or its `paseo.team` label. They carry `paseo.team-run`, which only scopes peer messaging.
- Providers that ignore `systemPrompt` (ACP providers and Copilot) never see the roster. Lead a team with a provider that supports it, such as Claude, Codex, OpenCode or Pi. ACP providers work as roles.
- A helper on a different provider than the chat needs an explicit `settings.modeId`; the roster tells the chat so. Set `modeId` on roles to avoid the extra lookup.
