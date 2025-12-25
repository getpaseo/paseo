# Investigation: Claude Provider Permissions in Daemon E2E Tests

## Root Cause

The Claude permission tests in `daemon.e2e.test.ts` don't work because they read the **user's real `~/.claude/settings.json`** which has `Bash(rm:*)` in the `allow` list. This causes `rm` commands to execute without requesting permission.

### Why Direct Tests Work (`claude-agent.test.ts`)

The direct tests use `useTempClaudeConfigDir()` at `packages/server/src/server/agent/providers/claude-agent.test.ts:57-87`:

```typescript
function useTempClaudeConfigDir(): () => void {
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const sourceConfigDir = previousConfigDir ?? path.join(os.homedir(), ".claude");
  const configDir = mkdtempSync(path.join(os.tmpdir(), "claude-config-"));
  const settings = {
    permissions: {
      allow: [],
      deny: [],
      ask: ["Bash(rm:*)"],  // <-- Forces rm to request permission
      additionalDirectories: [],
    },
    sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
  };
  writeFileSync(path.join(configDir, "settings.json"), settingsText, "utf8");
  writeFileSync(path.join(configDir, "settings.local.json"), settingsText, "utf8");
  copyClaudeCredentials(sourceConfigDir, configDir);
  process.env.CLAUDE_CONFIG_DIR = configDir;  // <-- SDK reads from this
  return () => { /* cleanup */ };
}
```

This:
1. Creates a temporary config directory with custom `settings.json`
2. Sets `CLAUDE_CONFIG_DIR` environment variable to point to it
3. Includes `ask: ["Bash(rm:*)"]` so `rm` commands request permission
4. The test's `beforeAll()` calls this before any tests run

### Why Daemon E2E Tests Fail

The daemon tests at `packages/server/src/server/daemon.e2e.test.ts:910-1094`:
1. Start a daemon server via `createTestPaseoDaemon()`
2. The daemon runs in-process (not a separate process)
3. No temp config directory is set up
4. The Claude SDK uses `settingSources: ["user", "project"]` (line 665 of `claude-agent.ts`)
5. SDK reads `~/.claude/settings.json` which has `allow: ["Bash(rm:*)"]`
6. `rm` commands auto-execute without permission prompt

### Evidence

User's `~/.claude/settings.json`:
```json
{
  "permissions": {
    "allow": [
      "Bash(rm:*)",   // <-- This allows rm without permission
      ...
    ],
    ...
  }
}
```

## Solution Options

### Option 1: Use `CLAUDE_CONFIG_DIR` in Daemon Tests (Recommended)

Modify `createDaemonTestContext()` or add a new function for permission tests:

```typescript
function useTempClaudeConfigDir(): () => void {
  // Same implementation as claude-agent.test.ts
  // Set CLAUDE_CONFIG_DIR before test starts
}

// In permission test beforeAll:
beforeAll(() => {
  restoreConfigDir = useTempClaudeConfigDir();
});
afterAll(() => {
  restoreConfigDir?.();
});
```

Since the daemon runs in-process, `process.env.CLAUDE_CONFIG_DIR` should work.

### Option 2: Use SDK's `allowedTools` Override

The Claude SDK has an `allowedTools` option that auto-allows specific tools. We could potentially use a combination of SDK options to override filesystem settings.

However, the SDK docs say `settingSources: []` (empty) creates "SDK isolation mode" where no filesystem settings are loaded. We could:
1. Set `settingSources: []` to ignore user settings
2. Provide explicit permission rules via SDK options

This would require changes to how `claude-agent.ts` configures the SDK.

### Option 3: Skip Tests When User Settings Conflict (Not Recommended)

Could detect if user has `Bash(rm:*)` in allow list and skip tests. This is fragile and doesn't actually test the permission flow.

## Recommended Fix

**Option 1** is simplest and most consistent with how `claude-agent.test.ts` already works:

1. Create a shared `useTempClaudeConfigDir()` utility in test-utils
2. Use it in the Claude permission tests in daemon.e2e.test.ts
3. Ensure the temp config has `ask: ["Bash(rm:*)"]` to force permission requests

The daemon runs in the same process, so setting `CLAUDE_CONFIG_DIR` before creating agents should work.

## Files Analyzed

- `packages/server/src/server/agent/providers/claude-agent.test.ts:57-87` - temp config setup
- `packages/server/src/server/agent/providers/claude-agent.ts:651-670` - SDK options including `settingSources`
- `packages/server/src/server/daemon.e2e.test.ts:903-1094` - skipped permission tests
- `packages/server/src/server/test-utils/paseo-daemon.ts` - daemon creation (no config override)
- `node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/agentSdkTypes.d.ts:983-991` - `settingSources` docs
- `~/.claude/settings.json` - user's actual settings with `allow: ["Bash(rm:*)"]`
