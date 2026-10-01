# Team runtime

Status: accepted 2026-10-01. Runtime and `software-basic` are built (`packages/server/src/server/team/`).

Pilot evidence, real Codex sessions against an isolated daemon (2026-10-01):

| Acceptance                             | Result                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Team start from a boss session       | verified: `team_start` → PO plan → items                                                                                              |
| 2 Daemon restart mid-work              | verified: restarts during reviewer and tester turns resumed the same sessions, no new agents, no false findings                       |
| 3 Parallel developers in own worktrees | verified: three developers ran at once                                                                                                |
| 4 Conflicting item waits               | verified: `titleCase` started after `countWords` finished                                                                             |
| 5 Red test goes back to the developer  | verified: same developer session, then pass                                                                                           |
| 6 Review finding goes back             | verified in unit test; real runs had no finding                                                                                       |
| 7 Provider limit switches profile      | in-turn fallback skips profiles at their limit; exhausted seats wait for the earliest known reset (unit tests); not yet seen live     |
| 8 Readable team feed                   | Teams screen lists teams, reads their event log, links worker sessions, and sends input to the team; `team_status` also reads the log |

Decisions taken while building:

- `team_start` asks Jev whether the job needs a team; a confident "single" sends the boss back to
  do it alone unless it passes `force`.
- Packs declare Jev judgements on working-phase outcomes (`judge`: question, criteria, routes).
  `software-basic` judges a failed test (code, test, environment, requirement; the last two go to
  the boss) and requested changes (blocker, major, minor; minor passes). Without Jev, or below the
  confidence floor, the reported outcome stands.
- The reviewer runs the `codex-review` skill against an evidence file the runtime writes from the
  item's goal and criteria.
- Packs load from `<storage root>/packs/<id>/pack.mjs`; a pack's `matches(cwd)` claims a repository
  when `.pandaos/project.json` names no pack. The 9elf26 pack lives in `9elf26/9elf26-workflows`
  (`pandaos/pack.mjs`) and reuses that repository's agent contracts.
- Seat tools come from the pack role (`pandaos.team.tools` label), not from a fixed role name.
- `dependencyPhase` says when a dependency counts as met (`done` by default, `ready-for-human` for
  9elf26 stacks).
- A seat is written before its agent starts and is found by the `pandaos.team.decision` label, so a
  report that races the agent id still lands and a crash leaves a seat recovery can finish.
- Tool gating uses the agent's labels at session launch, and the MCP endpoint falls back to the stored
  record, because a resuming session lists its tools before the agent is registered again.
- `canEdit: false` is prompt-only on Codex (no read-only mode); Claude and OpenCode `plan` modes are
  not used yet because testers must run commands.
- A worker's own branch claims are ignored; the runtime records the branch the developer's worktree has
  at handover, because PandaOS renames worktree branches after the first prompt.

The team runtime lets one PandaOS session hand a larger job to a team of agents and get one result
back. The runtime is generic. Everything a company or project does differently lives in a
**workflow pack**. The runtime knows nothing about Jira, Confluence, `gh stack`, Greptile or any
other external system.

## Layers

| Layer                                                 | Owns                                                                                                                | Does not own                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Core runtime (`packages/server/src/server/team/`)     | work items, boards, bindings, decisions and dispatcher, event log, health, Jev decision service, pack registry      | phases, roles, skills, external systems                |
| Workflow pack (a PandaOS plugin)                      | board (phases), roles and their skills, transition rules, pack-specific Jev decisions, adapters to external systems | which harness runs a role, scheduling, agent lifecycle |
| Project profile (`.pandaos/project.json` in the repo) | which pack, generic git facts, role-to-harness bindings, pack config                                                | behaviour                                              |
| Agent sessions (existing daemon)                      | Claude Code, Codex, OpenCode runs, streaming, resume, worktrees                                                     | team state                                             |

Two rules keep this from turning into Paperclip again:

1. **One source of truth.** Team state lives in the daemon, next to agent state, in the same
   file-based JSON store. There is no second server and no adapter between two stores.
2. **Only the dispatcher starts agents.** There is exactly one scheduling layer. Packs, rules,
   the PO and workers only emit decisions; the dispatcher alone calls the agent manager. Bound
   agents get no `create_agent` tool at all. A worker that needs more work done says so in its
   report; the runtime decides.

## Concepts

Patterns are adapted from `mastra-ai/mastra` `mastracode/factory` (Apache-2.0). We take the
orchestration layer and cut it off at the agent runtime: Mastra's AgentController, sessions,
memory, model handling and sandbox are replaced by PandaOS agent sessions. Copied files keep the
Apache notice and say they were modified; see `NOTICE`.

### Work item

```ts
type WorkItem = {
  id: string;
  teamId: string;
  packId: string;
  packVersion: number; // board version this item was created against
  parentId?: string;
  title: string;
  objective: string;
  phase: string; // one phase at a time, defined by the pack's board
  phaseHistory: { phase: string; enteredAt: string; exitedAt?: string; by: Actor }[];
  revision: number; // every write checks and bumps it; a stale writer gets `stale`
  dependsOn: { id: string; until: string }[]; // `until` is a phase of the other item
  conflictsWith: string[]; // never run at the same time
  exclusive?: boolean; // runs alone (e.g. a DB migration)
  acceptanceCriteria: { id: string; text: string; met?: boolean; evidence?: string }[];
  artifacts: Artifact[]; // branch, commit, PR, screenshot, test run, document
  bindings: Record<string, string>; // role -> binding id
  pack: Record<string, unknown>; // pack-owned fields, opaque to the runtime
};
```

`dependsOn.until` is how 9elf26's `submitted < reviewed < merged` gates become generic: the pack
names the phases, the runtime only compares them.

### Board

```ts
type Board = {
  initialPhase: string;
  phases: Record<
    string,
    {
      title: string;
      kind: "resting" | "working" | "terminal";
      role?: string; // required for working phases, forbidden otherwise
      outcomes?: Record<string, string>; // outcome name -> next phase
    }
  >;
};
```

A working phase has exactly one role. When an item enters a working phase, the runtime binds that
role; when the worker reports an outcome, the runtime moves the item to `outcomes[outcome]`. An
outcome the board does not declare is rejected, never guessed.

### Role

```ts
type Role = {
  id: string; // "po", "developer", "tester", "reviewer", "analyst", ...
  instructions: string; // the contract a worker follows, provider-neutral
  skills: string[]; // loaded only into this role's session
  resultSchema: ZodSchema; // what the worker must report
  worktree: "own" | "shared" | "none";
  canEdit: boolean; // reviewers and analysts get read-only sessions
};
```

The pack says what a role does. The **project profile** says who does it:

```json
{ "roles": { "developer": { "provider": "codex", "model": "gpt-6.1-sol", "effort": "high" } } }
```

Without a profile entry the runtime uses the model ranking from the global agent rules. The same
9elf26 pack therefore runs with Claude Code, Codex or OpenCode as its developer.

### Binding

```ts
type Binding = {
  id: string;
  workItemId: string;
  role: string;
  phase: string; // the phase this seat was minted for
  revisionAtStart: number; // item revision when the seat was minted
  decisionId: string; // the start-role decision that created it
  agentId: string; // a normal PandaOS agent, labelled team.* so the UI can group it
  profile: string; // provider profile it runs on, e.g. codex-business
  status: "active" | "revoked";
  turn: "starting" | "running" | "idle" | "reported";
  lastEventAt: string;
  createdAt: string;
  revokedAt?: string;
};
```

One active binding per (item, role). The binding is what survives a daemon restart. On start the
runtime walks active bindings and, for each one, reads the agent's persisted record:

- turn ended with a `team_report` → ingest it;
- turn ended without one → `report-missing` finding;
- agent still running after resume → keep waiting;
- agent gone or its provider session lost → `start-role` again with the same prompt, same
  worktree, and the previous transcript summary.

The in-memory "wait for this agent" closure that exists today is never the only record of an
outstanding wait.

### Decision and dispatcher

Rules and the PO do not act; they emit decisions. The dispatcher executes them.

```ts
type Decision = {
  id: string;
  idempotencyKey: string;
  workItemId: string;
  kind:
    | "transition"
    | "start-role"
    | "message-role"
    | "notify-human"
    | "abort-role"
    | "invoke-pack-action"; // { packId, action, input }: Jira, gh stack, GitHub, ...
  payload: unknown;
  status: "pending" | "leased" | "succeeded" | "retry" | "failed" | "superseded" | "proposed";
  attempts: number;
  availableAt: string;
  lastError?: string;
  createdAt: string;
};
```

- A transition and its decisions are written together, so a crash cannot leave one without the other.
- Retries back off exponentially up to five attempts. Each failure code says whether it may retry.
- Before running, a decision is checked against the item's phase history. A decision overtaken by a
  later transition becomes `superseded`, not `failed`.
- `proposed` is the approval gate: the decision waits for Boss or the human.

This is where provider limits, capacity errors and restarts are handled: the dispatcher retries
`start-role` on another profile per the account-switch rules. The PO never restarts processes.

### Worker result

Every worker ends its turn with a `team_report` tool call. The worker supplies only the payload:

```ts
type TeamReportPayload = {
  outcome: string; // must be an outcome of the current phase
  summary: string; // plain language, shown in the team chat
  artifacts?: Artifact[];
  criteria?: { id: string; met: boolean; evidence: string }[];
  needs?: { kind: "human" | "research" | "split"; text: string };
};
```

The runtime wraps the payload in an envelope it builds from the calling agent's binding:
`bindingId`, `workItemId`, `role`, `phase`, `revisionAtStart`. The tool has no input for any of
these, so a model cannot report for another item or an older state.

Ingestion is one commit: accept the report, apply artifacts and criteria, set the binding to
`reported`, append the event and emit the follow-up decisions. The report carries an idempotency
key (`bindingId`), so a crash after the commit and a repeated tool call do not process it twice,
and a crash before the commit leaves the binding `running`, where recovery finds the report in the
agent's transcript.

The runtime accepts a report only when the binding is still active, the item is still in the
binding's phase, and the commit's revision check passes. Anything else is stored as a
`report-rejected` event and never moves the item. A turn that ends without a valid report is a
health finding, not a silent success.

### Event log and team chat

`<daemon storage root>/teams/<teamId>/events.jsonl` is append-only (the root is the daemon's
existing home directory, `~/.pandaos`; the runtime adds no new environment variables or
legacy-named paths): item created, phase moved, transition
rejected, role started, report received, decision failed, human message. The team chat tab is a
projection of this log. Direct conversations are filtered views of the same log (`to: boss`,
`to: role`). Nothing is said in the team that is not in the log.

### CLI and agent tracking

The Teams screen and `pandaos team` commands use the same daemon state. Use `team ls` to find a
team, `team inspect <id>` for its phases and bindings, and `team events <id> --after
<commit>` for one incremental history read. `inspect` returns the snapshot commit; its `--json`
output also includes the event history. Pass `--json` for
scripts or agents, and `--host` to select another daemon. `team message <id> <text>` sends input
through the existing team-message path and resumes work waiting for an answer.

Team creation stays with the boss's `team_start` tool. The CLI does not introduce another
dispatcher. The [factory skill](../skills/pandaos-factory/SKILL.md) adapts Poteto's practices for
small verifiable items and decision evidence to this runtime and the project's selected pack.

Tracking a reported outcome does not independently verify it. Cost budgets, protected checks,
credential isolation, and acceptance of the final commit still need enforcement outside these
read commands. Worktree isolation alone does not restrict process or credential access.

### Factory requirements still open

Compared with the [9elf26 factory draft](https://9elf26.atlassian.net/wiki/spaces/~71202050dcf3a874274739a21aec064ed3cb73/pages/1174667265), the generic runtime already provides persisted phases, leased decisions, retries, concurrency limits and recovery. Company workflow packs own their integrations and policies.

| Requirement                | Remaining enforcement                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stove                      | Scoped credentials and process/network isolation; hard cost and lifetime budgets; stopping active workers                                                                                               |
| Trigger                    | Ownership across teams for the same ticket, stage and commit; chain-wide depth and resource limits                                                                                                      |
| Verification               | Protected tests and infrastructure; independent acceptance evidence bound to the final commit. The current 9elf26 pack allows reviewer edits after validation without requiring another validation pass |
| Insights and logbook       | Connect team events to product, ticket, role, skill and cost metadata; integrate the company's logbook and analyst                                                                                      |
| Feature map and outer loop | Connect acceptance scenarios and the existing verify runner to team gates; add incident and user-report triggers                                                                                        |

These are source-level findings from 2026-10-01. The CLI/browser check covers a controlled tracking fixture, not a multi-week autonomous factory run.

### Health

A pure function over the store and agent states, run every few minutes and after every event. It
finds, without a model:

| Finding          | Meaning                                          | Automatic repair                     |
| ---------------- | ------------------------------------------------ | ------------------------------------ |
| `decision-stuck` | pending past its time, or lease expired          | re-lease                             |
| `start-stalled`  | agent never started                              | retry on next profile                |
| `seat-orphaned`  | active binding on a terminal or missing item     | revoke                               |
| `seat-missing`   | working phase, no binding, no decision in flight | emit `start-role`                    |
| `report-missing` | bound agent idle without `team_report`           | message the role once, then escalate |
| `no-progress`    | bound agent running, no event for N minutes      | escalate to Boss                     |
| `cost-spike`     | turn or item cost above threshold                | escalate to Boss with the numbers    |

Deterministic findings are repaired by the runtime. Boss only sees what needs judgement.

### Jev decisions

`jev.decide(kind, options, state)` is a runtime service. The core registers `team-needed`,
`review-severity`, `failure-kind`, `human-needed`. Packs register their own
(`product-foundation-ready` for 9elf26). Facts the runtime can read are never asked: test results,
PR state, dependency state, phase.

## Tool profiles

The runtime, not the pack, decides which tools each bound session gets:

| Session           | Team tools              | Code access        |
| ----------------- | ----------------------- | ------------------ |
| Boss              | `team_*`                | normal session     |
| PO                | `item_*`, `team_report` | read-only          |
| developer, tester | `team_report`           | per role `canEdit` |
| reviewer, analyst | `team_report`           | read-only          |

No bound session gets `create_agent`, `send_agent_prompt` or schedule tools. Read-only is enforced
per provider where the harness supports it (Claude Code tool allow/deny lists, Codex read-only
sandbox, OpenCode permissions). Where a provider cannot enforce it, the session shows a
`prompt-only` badge so the gap is visible. The pilot checks each provider.

## Boss and PO

- **Boss** is the session the human talks to. It gets `team_start`, `team_status`,
  `team_message`, `team_pause`, `team_cancel`. It speaks to the human; nobody else does.
- **PO** is a core role with `item_create`, `item_split`, `item_transition`, `item_reopen`.
  It plans against the pack's board and never edits code.

## Workflow packs

A pack has an `id` and an integer `version`. Every team and work item stores the `packId` and
`packVersion` it was created against. On load, a mismatch with the installed pack pauses the team
with a `pack-version-mismatch` finding unless the pack ships a `migrate(fromVersion, snapshot)`
hook for that version; the runtime never silently runs an old item against a new board.

Packs contribute typed actions (`actions: Record<name, { input: ZodSchema, run }>`). A rule or role
asks for one through an `invoke-pack-action` decision; only the dispatcher calls `run`, with the
same lease, retry and idempotency rules as every other decision.

A pack is a PandaOS plugin (see [plugins.md](plugins.md)) that contributes `teamWorkflows`. Pack
rules are pure functions from an item snapshot to decisions; they get no agent, process or
filesystem API from the runtime. Adapters to external systems (Jira, Linear, `gh stack`) run as
the pack's own plugin RPCs, called from roles or rules through decisions. The contribution:
`{ id, board, roles, rules?, transitionPolicy?, jevDecisions?, profileSchema }`. `profileSchema`
validates the pack's own section of `.pandaos/project.json`, so a company adds Jira or Linear
config without the runtime knowing either.

| Pack                                                                         | Board                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `software-basic` (pilot, ships with PandaOS)                                 | `intake → plan → implement → test → review → done`                                          |
| `9elf26` (port of `9elf26/9elf26-workflows`, `gh stack` instead of Graphite) | `intake → brief → plan → intake-analysis → implement → validate → review → ready-for-human` |

## Pilot

The pilot runs `software-basic` on the PandaOS repo itself and has to show, with a real run:

1. Boss starts a team from a normal session; the PO splits the job into items.
2. **Restart first:** kill and restart the daemon while a developer is running and again while a
   report is in flight. Nothing may be lost or run twice. This is tested as soon as bindings and
   the dispatcher exist, before any other acceptance step.
3. Two developers work in parallel in their own worktrees; a conflicting item waits.
4. A failing test sends the item back from `test` to `implement`.
5. A reviewer finding sends it back; the fix passes.
6. A provider limit on one worker is retried on another profile without human input.
7. The team chat shows all of it, in order, in plain language.

Only after that does the 9elf26 port start, with Graphite replaced by `gh stack`.

## Open questions

- Can a PandaOS session be started without shell access for PO and reviewer roles on every
  provider, or is `canEdit: false` a prompt-level rule on some of them?
- Does the event log need a size cap per team, or is archiving finished teams enough?
