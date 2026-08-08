# Codex Voice MCP Approval

## Problem

Codex voice-mode sessions were receiving the injected `paseo` MCP server, but Paseo was not forwarding Codex-specific MCP approval settings into the app-server config. As a result, `paseo.speak` fell back to Codex's default MCP approval behavior and could be rejected before Paseo's voice auto-allow hook ever ran.

## Fix

Paseo now carries Codex MCP approval metadata in `extra.codex.mcpServerPolicies` and forwards it only through the Codex adapter as:

- `mcp_servers.<id>.enabled_tools`
- `mcp_servers.<id>.default_tools_approval_mode`
- `mcp_servers.<id>.tools.<tool>.approval_mode`

For Codex voice mode, the injected `paseo` server is now configured with:

- `enabled_tools = ["speak"]`
- `default_tools_approval_mode = "prompt"`
- `tools.speak.approval_mode = "approve"`

This keeps the approval override limited to `speak` while leaving the normal generic `paseo` MCP server in place.

The voice approval override is intentionally Codex-only. Other providers use different permission systems or do not
accept these Codex-specific MCP approval fields, so they receive the generic `paseo` MCP server without this metadata.

## Verification

1. Build or restart the Paseo server from this branch.
2. Start a fresh Codex voice conversation.
3. Speak a short prompt.
4. Confirm the response uses `mcp__paseo.speak` and plays without a manual approval prompt.

Focused tests:

- `./node_modules/.bin/vitest run packages/server/src/server/session.voice-mcp-config.test.ts packages/server/src/server/session/voice/voice-session.test.ts`
- `./node_modules/.bin/vitest run packages/server/src/server/agent/providers/codex-app-server-agent.test.ts -t "maps MCP approval settings into Codex inner config"`

## Revert

Revert the commit that introduced this change, then restart the daemon so Codex sessions pick up the reverted MCP config mapping.
