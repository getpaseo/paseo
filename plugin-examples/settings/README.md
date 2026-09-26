# Settings example

Install this directory with `paseo plugin install /absolute/path/to/plugin-examples/settings`.
Open Settings → Plugins → settings-example → Display, or run **Configure agent monitor** in Command Center.

The select and switch save immediately. The title editor keeps a draft and its original revision,
so another client's save produces a conflict instead of overwriting its changes. Close and reopen
the editor to discard the draft and use the latest settings.

Every UI component is a plain named import. The custom preview shares the same values without
using a form wrapper. Values are shared by clients connected to the same host.

The server contribution also demonstrates the daemon-side document handle. It reads during
startup, performs serialized updates from a typed RPC handler, and updates from an
`agent.created` lifecycle callback. These operations share the same settings file, migration
loader, queue, revision and client invalidation path as `useSettings`.

The same screen on [Android](screenshots/android.png), [Electron](screenshots/electron.png),
and [compact web](screenshots/web-compact.png).
