# Provider Account Profiles

Provider account profiles keep multiple Codex and Claude subscription sign-ins available on one
Paseo host without copying credentials into daemon configuration. They are separate from custom
providers: a provider account changes _who_ runs the built-in provider, while a custom provider can
change its binary, API endpoint, environment, and model catalog.

## User model

Open **Host settings → Providers → Provider accounts**. Each supported provider contains:

- **System account** — the sign-in already configured on the host. It remains available and is the
  compatibility default.
- **Managed accounts** — named, isolated sign-ins such as Personal, Work, or Client.
- **Default** — the account selected for new agents when no explicit account was chosen.

Creating a managed account creates only an isolated private runtime directory. Use **Sign in** on
the row to authenticate it:

- Codex uses app-server's `account/login/start` device-code flow. Paseo displays the official
  verification URL and one-time code.
- Claude runs `claude auth login` with that account's `CLAUDE_CONFIG_DIR`, then reads
  `claude auth status --json` to record display identity.

Paseo never sends access tokens, refresh tokens, credential paths, or runtime-home paths over the
client protocol. Public account records contain only the generated ID, provider, name, display
identity, and timestamps.

## Selection and pinning

The account control appears in the new-agent composer after a host has at least one managed account
for the selected provider. Agent profiles can also save `accountProfileId` alongside provider,
model, mode, thinking, and features.

Account selection has three states:

- omitted: follow the host's current default when the agent is created;
- a managed `pac_…` ID: use that isolated account;
- `null`: explicitly use the System account, bypassing a managed default.

The daemon resolves the choice once and persists it on the agent. Resume, reload, fork, cached UI
state, and agent listings keep that pinned ID. Changing the host default never moves a running or
previously created agent. Same-provider subagents inherit their parent's pinned account unless the
caller explicitly supplies another account.

An account cannot be removed while an active agent is pinned to it. Archive those agents first;
removal then deletes the managed runtime directory and resets that provider's default to System if
needed.

## Seamless continuation instead of process mutation

A provider process owns its authentication and native conversation ID, so Paseo does not rewrite
the account underneath a running process.

On a live thread:

- choosing another account;
- selecting a model from another provider; or
- applying an agent profile that changes provider or account

opens a linked draft in the same workspace. Paseo attaches the current conversation through its
native fork-context attachment, applies the requested provider/account setup to the draft, and
leaves the original thread intact. Sending the draft creates a fresh provider session pinned to the
new account. This gives one-click switching without corrupting either provider's session state.

Same-provider model, thinking, mode, and feature changes continue to apply to the running process
when the provider supports them.

## Usage and reset meters

**Host settings → Usage** lists System and every managed Codex/Claude account separately. Each row
uses that account's isolated credential store and shows the provider's normalized session, weekly,
model-scoped, code-review, credit, and reset data when available. Refresh forces a new daemon fetch;
ordinary reads share a five-minute cache. Adding or renaming an account invalidates the cache key.

Usage fetchers remain read-only on credentials. They never redeem refresh tokens or rewrite a CLI
credential file.

## CLI and agent tools

Discover managed IDs:

```bash
paseo provider accounts
paseo provider accounts --json
```

Pin a run:

```bash
paseo run --provider codex/gpt-5.4 --account pac_0123456789abcdef "Fix the tests"
paseo run --provider codex/gpt-5.4 --system-account "Fix the tests"
```

Omitting both flags follows the host default. `--account` and `--system-account` are mutually
exclusive.

The `list_profiles` agent tool returns `accountProfileId` when a saved profile contains one.
Materialize it into `create_agent.settings.accountProfileId`; pass `null` for System. There is still
no `profile` parameter because profiles are launch bundles rather than durable agent identity.

## Compatibility and migration

No credential or config migration runs automatically:

- existing host credentials remain the System accounts;
- existing agents without an account field continue to use their original provider behavior;
- existing agent profiles without `accountProfileId` follow the host default at creation time; and
- custom provider aliases remain supported for custom endpoints, API keys, and binaries.

Managed account metadata is stored under `$PASEO_HOME/provider-accounts/accounts.json`. Provider
runtime homes are derived server-side under the same private directory and are intentionally absent
from the registry protocol.
