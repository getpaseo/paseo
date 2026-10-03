# Paseo Spacedrive Bridge

This plugin provides a restricted Paseo RPC bridge to a local Spacedrive daemon.

## Current scope

- Detect or start `sd-daemon.exe`.
- Connect only to `127.0.0.1:6969`.
- Expose typed Paseo RPCs for daemon status, file search, and copying a remote file into Paseo's cache.
- Search and copy require a library UUID; this is required by Spacedrive's library-scoped wire registry.
- Reject destinations outside a Paseo `remote-cache` path.
- Never expose arbitrary Spacedrive RPC forwarding.
- Run `npm run mcp` to expose the same restricted operations over MCP stdio.

Set `SPACEDRIVE_DAEMON` to the absolute daemon executable path before starting Paseo, for example:

```powershell
$env:SPACEDRIVE_DAEMON = 'D:\ai\spacedrive\target\release\sd-daemon.exe'
```

The daemon protocol is newline-delimited JSON over loopback TCP. Requests use the tagged envelope
`{"Query":{"method":"search.files","library_id":"...","payload":{...}}}` or
`{"Action":{"method":"files.copy.input","library_id":"...","payload":{...}}}`. The adapter is isolated in `server/bridge.ts` so changes in the daemon wire contract do not leak into the client surface.

## MCP configuration

Add the server to the agent's MCP configuration with the absolute working directory:

```json
{
  "mcpServers": {
    "paseo-spacedrive": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "D:\\ai\\paseo-spacedrive-bridge",
      "env": {
        "SPACEDRIVE_DAEMON": "D:\\ai\\spacedrive\\target\\release\\sd-daemon.exe",
        "PASEO_REMOTE_CACHE": "D:\\ai\\Paseo\\remote-cache"
      }
    }
  }
}
```
