---
title: Provider options
description: Sandboxing, permissions, and network rules for Codex, Claude, and OpenCode agents created from the SDK.
nav: Provider options
order: 55
category: TypeScript SDK
---

# Provider options

`config.options` passes settings straight through to the provider CLI. Paseo validates the object against that provider's strict schema before starting the agent, so an unknown or misspelled key fails agent creation instead of silently doing nothing.

Options are provider-native. A Codex sandbox key is not a Claude sandbox key. Codex, Claude, and OpenCode accept options; every other provider rejects a non-empty `options`.

Provider options are not a host boundary. They constrain the agent CLI, which runs as your user on your machine. For untrusted work, run the daemon in a container or on a separate machine. See [Security](/docs/security).

## Codex

Confine writes to one directory, cut off network access, and stop approval prompts so the run is unattended:

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: {
    provider: "codex/gpt-5.5",
    options: {
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: {
        writable_roots: ["/Users/me/dev/storefront"],
        network_access: false,
        exclude_slash_tmp: true,
      },
      web_search: "disabled",
    },
  },
  cwd: "/Users/me/dev/storefront",
  prompt: "Fix the failing checkout test.",
});

const result = await agent.waitForFinish();
console.log(result.status, result.lastMessage);

await client.close();
```

| Option                    | Values                                                                            |
| ------------------------- | --------------------------------------------------------------------------------- |
| `approval_policy`         | `untrusted`, `on-request`, `never`, or `{ granular: { … } }`                      |
| `sandbox_mode`            | `read-only`, `workspace-write`, `danger-full-access`                              |
| `sandbox_workspace_write` | `writable_roots`, `network_access`, `exclude_slash_tmp`, `exclude_tmpdir_env_var` |
| `web_search`              | `disabled`, `cached`, `indexed`, `live`                                           |
| `features`                | `multi_agent_v2`, `network_proxy` (boolean or a proxy/domain policy object)       |

`approval_policy: "never"` only removes the prompts. What the agent is allowed to touch is `sandbox_mode`. Setting `never` without a sandbox mode gives an unattended agent full access.

## Claude

Turn on Claude's own sandbox, restrict writes to the project, deny reads of credential directories, and allow only two domains:

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: {
    provider: "claude/claude-sonnet-5",
    options: {
      disallowedTools: ["WebFetch"],
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: {
          allowWrite: ["/Users/me/dev/storefront"],
          denyRead: ["/Users/me/.ssh", "/Users/me/.aws"],
        },
        network: {
          allowedDomains: ["registry.npmjs.org", "github.com"],
          strictAllowlist: true,
        },
      },
    },
  },
  cwd: "/Users/me/dev/storefront",
  prompt: "Install dependencies and run the focused test.",
});

const result = await agent.waitForFinish();
console.log(result.status, result.lastMessage);

await client.close();
```

| Option                  | Values                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `allowedTools`          | Tool names the agent may use without asking                                                             |
| `disallowedTools`       | Tool names the agent may never use                                                                      |
| `additionalDirectories` | Extra directories the agent may access                                                                  |
| `sandbox`               | `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `excludedCommands`, `filesystem`, `network` |
| `settings`              | `permissions` (`allow`/`ask`/`deny` rule lists) and a nested `sandbox`                                  |

`failIfUnavailable: true` makes agent startup fail when the sandbox cannot be established. Leave it off and Claude runs unsandboxed instead.

`sandbox.filesystem` takes `allowWrite`, `denyWrite`, `allowRead`, and `denyRead`. `sandbox.network` takes `allowedDomains`, `deniedDomains`, `strictAllowlist`, and proxy settings.

## OpenCode

Allow reads and edits, deny anything that reaches outside the project, and gate shell commands by pattern:

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: {
    provider: "opencode/opencode/gpt-5.5",
    options: {
      permission: {
        read: "allow",
        edit: "allow",
        webfetch: "deny",
        external_directory: "deny",
        bash: {
          "git status": "allow",
          "git diff*": "allow",
          "git push*": "deny",
          "*": "ask",
        },
      },
    },
  },
  cwd: "/Users/me/dev/storefront",
  prompt: "Implement the requested change and show me the diff.",
});

const result = await agent.waitForFinish();
console.log(result.status, result.lastMessage);

await client.close();
```

Every permission is `ask`, `allow`, or `deny`. Tools that take a target — `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `repo_clone`, `repo_overview`, `lsp`, `skill` — also accept a pattern map, where later keys act as the fallback. Tools without a target — `todowrite`, `question`, `webfetch`, `websearch`, `codesearch`, `doom_loop` — take a bare action.

`permission: "deny"` as a bare string applies to everything at once.

An `ask` resolves to a permission request in Paseo, and `waitForFinish()` returns `permission` while it is pending. Use `allow` and `deny` for unattended runs. See [Events](/docs/sdk/events) for reacting to a pending request.

## Modes and options

`modeId` picks a Paseo mode from the provider's published list, which the daemon shows in the app and reports through [provider discovery](/docs/sdk/providers). `options` is the provider's own configuration. They are separate controls and you can set both:

```ts
config: {
  provider: "codex/gpt-5.5",
  modeId: "full-access",
  options: {
    approval_policy: "never",
    sandbox_mode: "read-only",
  },
}
```

Where the two overlap, `options` wins. Above, Codex runs read-only even though `full-access` would otherwise grant more.
