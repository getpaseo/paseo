# Pi tasks timeline plugin example

This example implements the behavior proposed in Paseo PR #3751 as a plugin. It recognizes
completed Pi `todo` tool calls from both `@juicesharp/rpiv-todo` and Pi's
`examples/extensions/todo.ts`, replaces the tool-call entry with a versioned `pi-task-list` item,
and renders the current task snapshot with a native React Native component.

The rpiv shape preserves `pending`, `in_progress`, and `completed`; deleted tombstones are omitted.
Pi's example shape maps `done` to `completed` or `pending`. Malformed results and unrelated tool
calls return `undefined`, leaving Paseo's original timeline entry unchanged.

The transformer is a pure client contribution. It receives the daemon's projected timeline item,
returns plain plugin item objects, and runs against projected history. Matching live events refresh
the authoritative projected tail first. The renderer validates `data` before Paseo mounts the
component.
