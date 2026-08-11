# Local plugins

Local plugins contribute daemon RPCs, native app surfaces, and composer attachment sources from one
`index.tsx`. Paseo executes the server contribution in a subprocess and evaluates the client
contribution in the app runtime. Plugin code is trusted code; this first slice does not sandbox it.

## Configure a directory source

Enable local plugins and add the plugin to the root `plugins` object in `$PASEO_HOME/config.json`:

```json
{
  "pluginsEnabled": true,
  "plugins": {
    "my-plugin": {
      "source": "directory",
      "path": "/absolute/path/to/my-plugin"
    }
  }
}
```

The plugin system is disabled unless `pluginsEnabled` is `true`.

The directory contains an identity-only manifest and one entry point:

```text
my-plugin/
  paseo-plugin.json
  index.tsx
```

```json
{
  "id": "my-plugin"
}
```

The manifest ID must match the config key. Restart the development daemon after changing plugin
source or configuration; directory watching is outside the first slice.

## Contribute behavior and UI

Default export one contribution function. Paseo calls it with a plugin-scoped context. The compiler
removes UI registrations from the server bundle and RPC registrations from the client bundle before
resolving dependencies.

```tsx
import { Text } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { defineRpc, type PluginContext, useRpc } from "@paseo/plugin";

const greetRpc = defineRpc({
  name: "greet",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
});

function Greeting() {
  const greet = useRpc(greetRpc);
  const query = useQuery({
    queryKey: ["greeting", "Paseo"],
    queryFn: () => greet({ name: "Paseo" }),
  });
  return <Text>{query.data?.message}</Text>;
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(greetRpc, async ({ name }) => ({ message: `Hello, ${name}` }));
  plugin.addSurface("main", Greeting);
  plugin.addSidebarItem({
    id: "main",
    title: "Greeting",
    icon: "MessageCircle",
    surface: "main",
  });
}
```

Paseo owns the route, screen header, Lucide icon validation, close action, theme DTO, layout facts,
and render error boundary. The contributed component owns the complete body below the header.

RPC contracts validate inputs and outputs in both the app and plugin subprocess. `useRpc` returns a
typed async function. Use the host-provided `@tanstack/react-query` for request state and caching;
Paseo gives each plugin installation its own query client.

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
}
```

Attachment sources stay scoped to the composer's host. Unlike sidebar contributions, equal sources
on several hosts are not coalesced. The selected snapshot submits as a text attachment with neutral
external-resource presentation, so it remains readable if the plugin is removed or an older peer
drops the optional presentation fields.

See `plugin-examples/local-plugin` for a native surface and `plugin-examples/linear` for a complete
attachment-source example.
