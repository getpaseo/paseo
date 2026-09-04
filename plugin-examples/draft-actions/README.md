# Draft actions plugin example

This example adds two composer buttons that rewrite the current draft in place:

- **Tidy** trims trailing whitespace, collapses three or more blank lines to one, and trims the
  draft's edges. When the draft is already tidy it returns the input unchanged, which leaves the
  draft and caret untouched.
- **Checklist** turns `- item` lines into `- [ ] item` task lines, leaving everything else in the
  draft as-is.

Draft actions are the one contribution surface with no component: the plugin supplies an async
`transform(text, context)` and Paseo owns the button, pending spinner, error toasts, and teardown.
Both actions here are pure functions of the draft, so the plugin has no server entry; the
`context.agentId` / `context.workspaceId` fields are shown in the
[reference docs](../../public-docs/plugins/v0.8/reference.md#draft-actions) with an RPC-backed
rewrite that runs on the daemon side.
