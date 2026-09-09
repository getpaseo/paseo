# Pi tasks timeline plugin example

This example recognizes Pi `todo` tool calls from both `@juicesharp/rpiv-todo` and Pi's
`examples/extensions/todo.ts`, replaces the tool-call entry with a versioned `pi-task-list` item,
and renders the current task snapshot with a native React Native component. It transforms both
running and completed calls.

The rpiv shape preserves `pending`, `in_progress`, and `completed`; deleted tombstones are omitted.
Pi's example shape maps `done` to `completed` or `pending`. Malformed results and unrelated tool
calls return `undefined`, leaving Paseo's original timeline entry unchanged.

The transformer is a pure client contribution. It receives each source item and its streaming phase
while Paseo builds the render model, then returns plain plugin item objects. The renderer validates
`data` before Paseo mounts the component.

`index.client.tsx` wires the transformer from `shared/pi-tasks.ts` and renderer from
`client/pi-tasks.tsx`. The plugin has no server entry or subprocess.
