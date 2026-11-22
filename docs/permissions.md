# Daemon permissions

The daemon authorizes principals with semantic permissions. RPC names and protocol namespaces are not authority.

## Model

```text
principal -> grants
    |
    +-- authenticated by a device or service credential
    `-- opens a session with equal or narrower authority
```

A principal is the durable identity the daemon authorizes. A credential proves that a device or service represents it. Keep them separate so you can rotate credentials, attach more than one device, and revoke a Hub user without inventing daemon user accounts.

A pairing invitation is neither. It is an expiring, single-use exchange that creates a principal and credential with the permissions selected by its issuer.

## Permissions

| Permission          | Authority                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| `daemon.read`       | Daemon status, diagnostics, configuration, and provider information        |
| `daemon.manage`     | Restart, update, configuration changes, providers, skills, and plugins     |
| `tunnel.manage`     | Relay, Hub, service tunnel, and public endpoint relationships              |
| `access.manage`     | Pairing invitations, principals, credentials, grants, and revocation       |
| `workspace.read`    | Projects, workspaces, agents, timelines, files, diffs, and terminal output |
| `workspace.write`   | Prompts, agent control, files, terminals, git operations, and scripts      |
| `workspace.manage`  | Create, rename, archive, and remove projects and workspaces                |
| `automation.manage` | Schedules, heartbeats, and loops                                           |
| `hub.execute`       | Agent lifecycle, workspace titling, observation, and recovery              |

Agents and terminals use workspace authority. Both can execute code and mutate the workspace, so separate write permissions would claim an isolation boundary the daemon cannot enforce.

Connected-host management uses `tunnel.manage`; source-owned connection and metadata replacement
requires the producer or `access.manage`. Routed operations retain both caller and link authority,
see [Connected hosts](connected-hosts.md#ownership-and-authority).

Owner, operator, and viewer are UI presets expanded into explicit permissions. Do not persist them as roles. Adding a permission must not silently widen an existing principal.

Permissions are additive allows. Missing authority denies the operation. Do not add deny precedence.

## Scoped credentials

`daemon.auth.credentials` defines named secrets beside the owner password. Each resolves to the principal `credential:<name>` with its listed permissions (`resolveDaemonSecret` in `packages/server/src/server/auth.ts`). The WebSocket hello, the WebSocket bearer, and `/mcp/agents` accept them; the rest of the HTTP API stays owner-only because its routes have no permission classification.

A credential's `denyModes` attenuates the agent modes its sessions may use. It is not a permission and does not deny anything another grant allows. Check it where the mode is final: `createAgentCommand` checks the resolved mode, so provider defaults and inherited parent modes are covered, and the session gate checks mode changes on existing agents. It keeps a delegating system from starting dangerous-mode sessions; it does not contain code. `workspace.write` already lets agents and terminals run code as the daemon user, and agents call the agent MCP with the daemon's capability token, which carries no restriction. Schedules also run without the creator's restriction, so do not grant `automation.manage` to a credential with `denyModes`.

The agent MCP endpoint has no per-tool classification, so a scoped credential needs `workspace.write` to use it. `packages/server/src/server/authorization/agent-mcp-policy.ts` hides tools that need more than that.

## Resources

Permissions are daemon-wide today. Future grants may select workspaces or agents, but operation classification remains inside the authorization module:

```ts
type Grant = {
  permission: Permission;
  resource: { kind: "daemon" } | { kind: "workspace"; ids: string[] };
};
```

A delegating principal can grant only authority it already possesses. A session may attenuate its principal's grants but cannot widen them.

Workspace-scoped grants require every resource-bearing operation and outbound observation to enforce the same workspace boundary. File preview currently accepts any daemon-readable regular file, so it must gain resource enforcement before workspace-specific access ships.

## Hub

The Hub authenticates as a service principal. Its locally selected grants decide whether it may execute agents, manage the daemon, manage tunnels, or manage access.

Hub user and role identifiers remain opaque external subjects. The Hub may create and revoke linked daemon principals when granted `access.manage`; the daemon does not interpret accounts, organizations, or roles.

Hub enrollment and permission updates exchange these semantic permissions directly. Legacy persisted Hub relationships that contain `hub.execution.*` migrate once to `hub.execute` when the daemon loads them; new relationships never persist or emit transport scopes as authority.
