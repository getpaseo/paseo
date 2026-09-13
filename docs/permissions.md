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
| `hub.execute`       | Agent lifecycle, agent/workspace observation, and workspace recovery       |

Agents and terminals use workspace authority. Launching or controlling an agent still requires workspace write authority, including a read-only agent: its launch policy does not attenuate the caller's daemon permissions.

Owner, operator, and viewer are UI presets expanded into explicit permissions. Do not persist them as roles. Adding a permission must not silently widen an existing principal.

Permissions are additive allows. Missing authority denies the operation. Do not add deny precedence.

## Read-only agent launches

Set `writePolicy: "read_only"` at creation when a role must not write the workspace or other local files. Omission means `read_write`. The policy survives close, reload, archive, and daemon restart; changing it requires a new agent. Clients must require `server_info.features.agentWritePolicy` before creating or resuming a read-only agent on a daemon.

Only Codex on macOS with `sandbox-exec` is supported. Other hosts and providers, including OMP, reject read-only creation before provider startup and remain available for read-write roles. A provider mode, permission prompt, or system prompt does not establish this boundary.

Codex and its descendants run inside a write-denying OS boundary. Its native sandbox is disabled because macOS cannot nest it inside that boundary; native approvals remain disabled. Explicit Codex exec-policy allows cannot escape the outer restriction.

Read-only agents have no MCP servers or Paseo tools. Plugins orchestrate these roles from outside the agent. The isolated Codex home receives authentication only, not inherited user configuration, rules, hooks, or plugins. Other Paseo state, loopback connections, and local sockets are inaccessible except the system DNS resolver. Remote TCP port 443 remains available for model traffic; effects through remote APIs are outside this filesystem policy.

Each agent keeps its native conversation in `PASEO_HOME/codex-read-only/<agent-id>`, outside the workspace. Private temporary files are removed on close; durable state remains through archive and is removed when the agent is deleted. Do not put that state directory inside the workspace you want to protect.

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
