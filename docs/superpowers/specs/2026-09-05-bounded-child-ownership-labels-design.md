# Bounded Child Ownership Labels

## Goal

Allow a trusted plugin to attach bounded metadata labels when it creates a child agent while keeping parent ownership daemon-controlled.

## Contract

`host.children.create(options)` accepts an optional `labels: Record<string, string>`. The plugin-process and server schemas bound plugin input to `MAX_PLUGIN_HOST_CHILD_LABELS` (32) labels; the daemon-owned parent label is added outside that cap. Keys use `MAX_PLUGIN_AUTHORITY_LABEL_KEY_BYTES` (128) UTF-8 bytes and the ASCII-safe pattern `[A-Za-z0-9][A-Za-z0-9._-]*`; values use `MAX_PLUGIN_AUTHORITY_LABEL_VALUE_BYTES` (512) UTF-8 bytes. Case-insensitive `paseo.`, `plugin.`, `system.`, `internal.`, and `security.` namespaces, exact or dot-separated authority names, and dangerous prototype keys are rejected. `subagents.*` is allowed. The map is strict and cannot contain non-string values or unknown option fields.

The daemon copies the requested labels onto the child and adds `paseo.parent-agent-id` with the live caller ID. A plugin cannot forge, omit, or replace parentage. Workspace, cwd, provider, model, thinking, mode, provider options, and tool policy remain inherited from the live caller as before.

## Surfaces

- Protocol: validate child labels in the host request schema and retain strict response compatibility.
- Plugin SDK: expose the option in the public server contracts and generated scaffold declarations.
- Server: merge labels at child creation and use the canonical parent label constant.
- Documentation: describe the bounded map and reserved parent label in the internal and public plugin references.
- Tests: cover protocol acceptance/rejection, SDK/scaffold declarations, direct server behavior, and the standalone authority conformance executable.

## Compatibility

The new request field is optional. Older plugin processes continue to send child requests without labels. The daemon-owned parent label remains the existing canonical `paseo.parent-agent-id`; no legacy parent label is introduced.
