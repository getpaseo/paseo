# Bounded Child Ownership Labels

## Goal

Allow a trusted plugin to attach bounded metadata labels when it creates a child agent while keeping parent ownership daemon-controlled.

## Contract

`host.children.create(options)` accepts an optional `labels: Record<string, string>`. The plugin-process wire schema bounds plugin input to 127 labels so the daemon-owned parent label can be added within the 128-label authority limit; keys and values use the existing authority string byte limit. The map is strict and cannot contain non-string values or unknown option fields.

The daemon copies the requested labels onto the child, then overwrites `paseo.parent-agent-id` with the live caller ID. A plugin cannot forge, omit, or replace parentage. Workspace, cwd, provider, model, thinking, mode, provider options, and tool policy remain inherited from the live caller as before.

## Surfaces

- Protocol: validate child labels in the host request schema and retain strict response compatibility.
- Plugin SDK: expose the option in the public server contracts and generated scaffold declarations.
- Server: merge labels at child creation and use the canonical parent label constant.
- Documentation: describe the bounded map and reserved parent label in the internal and public plugin references.
- Tests: cover protocol acceptance/rejection, SDK/scaffold declarations, direct server behavior, and the standalone authority conformance executable.

## Compatibility

The new request field is optional. Older plugin processes continue to send child requests without labels. The daemon-owned parent label remains the existing canonical `paseo.parent-agent-id`; no legacy parent label is introduced.
