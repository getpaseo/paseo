# Preferences

The orchestrator reads user preferences from `~/.paseo/orchestrate.json` at startup. If the file doesn't exist, use the defaults below.

## Schema

```json
{
  "providers": {
    "impl": "codex/gpt-5.4",
    "ui": "claude/opus",
    "research": "codex/gpt-5.4",
    "planning": "codex/gpt-5.4",
    "audit": "codex/gpt-5.4"
  },
  "preferences": []
}
```

### providers

Maps role categories to `<agent-type>/<model>` strings. These map directly to the Paseo **create agent** tool parameters:

- The part before `/` is the `agentType` (e.g., `codex`, `claude`, `opencode`)
- The part after `/` is the `model` (e.g., `gpt-5.4`, `opus`)

| Category   | Roles covered                     |
| ---------- | --------------------------------- |
| `impl`     | impl, tester, refactorer          |
| `ui`       | impl agents doing UI/styling work |
| `research` | researcher                        |
| `planning` | planner, plan-reviewer            |
| `audit`    | auditor, qa                       |

If a category is missing, use these defaults:

- `impl` -> `codex/gpt-5.4`
- `ui` -> `claude/opus`
- `research` -> `codex/gpt-5.4`
- `planning` -> `codex/gpt-5.4`
- `audit` -> `codex/gpt-5.4`

### preferences

Freeform array of natural language strings. The user states preferences and the orchestrator appends them here. Read these at startup and weave them into your behavior contextually.

Examples:

- "Prefer small, focused PRs over large bundled ones"
- "Run E2E tests with Maestro, not Playwright"
- "Always check mobile responsiveness"
- "Use French for commit messages"

## Reading Preferences

At the start of every orchestration:

```bash
cat ~/.paseo/orchestrate.json 2>/dev/null || echo '{}'
```

Parse the JSON. Merge with defaults for any missing fields.

## Writing Preferences

When the user says "store my preference: X" or "remember that I prefer X":

1. Read the current file
2. If it's a provider change (e.g., "use Claude for implementation"), update `providers`
3. If it's anything else, append to `preferences`
4. Write the file back

Never remove preferences unless the user explicitly asks.
