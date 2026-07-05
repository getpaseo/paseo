# Codex Voice MCP Approval

## Problem

Codex voice-mode sessions were receiving the injected `paseo_voice` MCP server, but Paseo was not forwarding Codex-specific MCP approval settings into the app-server config. As a result, `paseo_voice.speak` fell back to Codex's default MCP approval behavior and could be rejected before Paseo's voice auto-allow hook ever ran.

## Fix

Paseo now carries MCP approval metadata in its shared agent config and forwards it to Codex as:

- `mcp_servers.<id>.enabled_tools`
- `mcp_servers.<id>.default_tools_approval_mode`
- `mcp_servers.<id>.tools.<tool>.approval_mode`

For Codex voice mode, the injected `paseo_voice` server is now configured with:

- `enabled_tools = ["speak"]`
- `default_tools_approval_mode = "prompt"`
- `tools.speak.approval_mode = "approve"`

This keeps the dedicated voice server limited to `speak` while explicitly auto-approving that tool.

## Verification

1. Build or restart the Paseo server from this branch.
2. Start a fresh Codex voice conversation.
3. Speak a short prompt.
4. Confirm the response uses `mcp__paseo_voice.speak` and plays without a manual approval prompt.

Focused tests:

- `./node_modules/.bin/vitest run packages/server/src/server/session.voice-mcp-config.test.ts packages/server/src/server/session/voice/voice-session.test.ts`
- `./node_modules/.bin/vitest run packages/server/src/server/agent/providers/codex-app-server-agent.test.ts -t "maps MCP approval settings into Codex inner config"`

## Revert

Revert the commit that introduced this change, then restart the daemon so Codex sessions pick up the reverted MCP config mapping.
