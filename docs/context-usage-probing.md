# Context Usage Probing

## Overview

Starting in v0.1.98, Paseo's Claude provider queries the current context window usage after each successful message completion by calling `getContextUsage()`. This provides precise context usage statistics but doubles the API request count.

**Prior to v0.1.98**, context usage was calculated from stream events and result usage data without additional API calls. This configuration allows you to restore that behavior.

## How it works

After each successful message, the daemon calls `getContextUsage()` on the Claude SDK, which sends a probe API request (with `max_tokens=1`) to retrieve:

- `totalTokens`: Current context window usage
- `maxTokens`: Maximum context window size for the current model

This information powers the context usage meter in the Paseo UI.

## Disabling context usage probing

If you want to reduce API request count and avoid the extra probe requests, you can disable this feature using an environment variable.

### Option 1: Environment variable (recommended)

Set `PASEO_DISABLE_CONTEXT_USAGE_PROBE=true` before starting the daemon:

```bash
export PASEO_DISABLE_CONTEXT_USAGE_PROBE=true
paseo daemon restart
```

Or add it to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.):

```bash
echo 'export PASEO_DISABLE_CONTEXT_USAGE_PROBE=true' >> ~/.bashrc
source ~/.bashrc
```

### Option 2: Per-provider configuration

You can also set it per provider in `~/.paseo/config.json`:

```json
{
  "providers": {
    "claude": {
      "env": {
        "PASEO_DISABLE_CONTEXT_USAGE_PROBE": "true"
      }
    }
  }
}
```

## Impact of disabling

When context usage probing is disabled, Paseo reverts to the **v0.1.97 behavior**:

### What changes:

- No additional API probe requests after each message
- Context usage is calculated from existing data (stream events and result usage)
- Slightly less precise in edge cases, but generally accurate

### What you gain:

- **50% fewer API requests** (no probe request after each message)
- **Reduced latency** (no 3-second timeout wait for context usage query)
- **Lower risk of hitting rate limits** during high-frequency usage
- **Lower API costs**

### Fallback behavior (same as v0.1.97)

Context usage is calculated from:

1. **Stream events** (`message_start`, `message_delta`): Incremental token counts during message streaming
2. **Result usage**: Final usage data included in the API response (`message.usage`)

This is the **exact same mechanism used in v0.1.97** and provides accurate usage statistics for normal operation.

## When to disable

Consider disabling context usage probing if:

- You're experiencing rate limit issues
- You're cost-conscious about API usage
- You frequently send many messages in quick succession
- You don't need real-time precise context window metrics

## Related

- GitHub issue: [#1685](https://github.com/getpaseo/paseo/issues/1685)
- Feature introduced in: v0.1.98 (commit `a924059da`)
- Fallback mechanism: See `buildResultUsage()` in `packages/server/src/server/agent/providers/claude/agent.ts`
