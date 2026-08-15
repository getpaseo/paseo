# Local plugins

Local plugins contribute daemon RPCs, native app surfaces, and composer attachment sources from one
`index.tsx`. Paseo executes the server contribution in a subprocess and evaluates the client
contribution in the app runtime. Plugin code is trusted code; this first slice does not sandbox it.

## Install a directory source

Create a typecheckable plugin project, install its development dependencies, then install it into
the daemon. `init` only writes the project files; it does not run the package manager.

```bash
paseo plugin init /absolute/path/to/my-plugin
cd /absolute/path/to/my-plugin
npm install
npm run typecheck
paseo plugin install /absolute/path/to/my-plugin
paseo plugin install /absolute/path/to/my-plugin --id another-runtime-id
paseo plugin ls
```

The daemon stores directory sources under the root `plugins` object:

```json
{
  "pluginsEnabled": true,
  "plugins": {
    "my-plugin": {
      "source": "directory",
      "path": "/absolute/path/to/my-plugin",
      "enabled": true
    }
  }
}
```

The plugin system is disabled unless `pluginsEnabled` is `true`. Changing that root field is
runtime-safe: run `paseo reload` after editing `config.json`. Enabling starts every configured,
enabled plugin; disabling tears them all down without restarting the daemon. Plugin source entries
remain lifecycle-owned and do not reload from manual config edits.

The directory contains an identity-only manifest, one entry point, and local typechecking support:

```text
my-plugin/
  paseo-plugin.json
  index.tsx
  paseo-plugin.d.ts
  package.json
  tsconfig.json
```

Paseo compiles TSX when loading the plugin, so these packages are development dependencies only.
The generated declaration file supplies `@paseo/plugin` types until the SDK is distributed as a
public package. Regenerate new plugins with the matching Paseo CLI when the SDK contract changes.

```json
{
  "id": "my-plugin"
}
```

The config key is the runtime plugin ID. The manifest ID is the default selected during install;
`--id` overrides it. Existing configuration is not renamed when the manifest changes, and the
runtime does not compare the two IDs. The same directory can be installed under several config
keys.

Never enable plugins on a user's behalf without explicit permission. Before asking, check the
target daemon's current `pluginsEnabled` value. State that plugins are trusted, unsandboxed code:
backend code can access the daemon machine, while client contributions run inside the Paseo app.

Source changes are explicit. Run `paseo plugin reload <id>` to stop and fully tear down the old
plugin before compiling and starting from disk. A failed reload stays failed; Paseo does not restore
the old code. Use `enable`, `disable`, and `remove` to manage one plugin. Remove deletes only its
configuration, never its source directory. The global `pluginsEnabled` switch remains available.

## Contribute behavior and UI

Default export one contribution function. Paseo calls it with a plugin-scoped context. The compiler
removes UI registrations from the server bundle and RPC registrations from the client bundle before
resolving dependencies.

```tsx
import { Text } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { defineRpc, type PluginContext, usePaseo, useRpc } from "@paseo/plugin";

const greetRpc = defineRpc({
  name: "greet",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
});

function Greeting() {
  const paseo = usePaseo();
  const greet = useRpc(greetRpc);
  const query = useQuery({
    queryKey: ["greeting", "Paseo"],
    queryFn: () => greet({ name: "Paseo" }),
  });
  const createWorkspace = () =>
    paseo.workspaces
      .create({
        source: {
          kind: "worktree",
          cwd: "/absolute/path/to/project",
          action: "checkout",
          checkoutSource: { kind: "change_request", forge: "github", number: 42 },
        },
      })
      .then((workspace) =>
        workspace.agents.create({
          config: { provider: "codex/gpt-5" },
          prompt: "Review PR #42",
        }),
      );
  return <Text onPress={() => void createWorkspace()}>{query.data?.message}</Text>;
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(greetRpc, async ({ name }, { paseo }) => {
    const { config } = await paseo.config.get();
    return { message: `${name}: ${config.pluginsEnabled ? "enabled" : "disabled"}` };
  });
  plugin.addSurface("main", Greeting);
  plugin.addSidebarItem({
    id: "main",
    title: "Greeting",
    icon: "MessageCircle",
    surface: "main",
  });
  return () => undefined;
}
```

The contribution function must return cleanup. Server cleanup may be async; Paseo waits for it when
the plugin is reloaded, disabled, removed, disconnected, or shut down. Cleanup is for resources
created by plugin code. Paseo removes registered contributions, unmounts surfaces, clears query
state, rejects pending RPCs, closes the plugin's daemon session, and stops the subprocess. Cleanup
errors are logged and do not interrupt host teardown.

Paseo owns the route, screen header, Lucide icon validation, close action, theme DTO, layout facts,
and render error boundary. The contributed component owns the complete body below the header.

RPC contracts validate inputs and outputs in both the app and plugin subprocess. `useRpc` returns a
typed async function. Use the host-provided `@tanstack/react-query` for request state and caching;
Paseo gives each plugin installation its own query client.

`usePaseo()` and the handler's `{ paseo }` context expose the same `PaseoApi`: workspaces, agents,
providers, and daemon config. They do not expose connection lifecycle. A surface borrows the
selected host's existing connection; switching the screen's host changes both `usePaseo()` and
`useRpc()` to that host. An offline selected host fails there and never falls through to another
installation. A server handler owns an IPC-backed daemon session for the life of its subprocess.
Use plugin RPC for plugin-specific backend behavior that is not a normal Paseo operation.

Each subprocess gets an exclusively owned `plugin:<id>` session. That identity is reserved from
normal clients, never resumes another session, and is cleaned immediately on exit without reconnect
grace. During daemon startup, plugin sessions may connect while application WebSockets remain
paused; the daemon accepts clients only after configured plugins have settled and the initial
catalog is complete.

When the same plugin contribution exists on multiple hosts, Paseo shows it once in the sidebar and
adds a host picker to the screen header. The selected host supplies the bundle, RPC transport, and
query cache. Plugin code cannot address another host.

## Contribute composer attachments

Register a declarative attachment source backed by a plugin RPC. Paseo owns the attachment menu,
search picker, drafts, selected pill, and submission. The plugin returns complete text snapshots;
credentials and vendor API calls stay in the daemon handler.

```tsx
const searchIssues = defineRpc({
  name: "issues.search",
  input: z.object({ query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string().url(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});

const issues = defineAttachmentSource({
  id: "issues",
  title: "Acme issue",
  icon: "CircleDot",
  pickerTitle: "Attach Acme issue",
  searchPlaceholder: "Search by identifier or title",
  search: searchIssues,
});

export default function contribute(plugin: PluginContext) {
  plugin.handle(searchIssues, ({ query }) => searchAcmeIssues(query));
  plugin.addAttachmentSource(issues);
  return () => undefined;
}
```

Attachment sources stay scoped to the composer's host. Unlike sidebar contributions, equal sources
on several hosts are not coalesced. The selected snapshot submits as a text attachment with neutral
external-resource presentation, so it remains readable if the plugin is removed or an older peer
drops the optional presentation fields.

See `plugin-examples/local-plugin` for a native surface and `plugin-examples/linear` for a complete
attachment-source example.
