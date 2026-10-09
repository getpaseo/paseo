# Linear plugin example

This example adds `Attach Linear issue` to the composer. Search by issue identifier
or title, then send a stable issue snapshot to the agent.

Set a personal API key in the daemon environment:

```bash
export LINEAR_API_KEY="lin_api_..."
```

Start your daemon with that environment variable set. Then turn on **Enable plugins** in
**Settings → Plugins** and install the example:

```bash
paseo plugin add /absolute/path/to/paseo/plugin-examples/linear
paseo plugin ls linear
```

Use `paseo plugin reload linear` after source edits. Changing the API key requires restarting the
daemon with the new environment; installing or reloading plugin source does not.

The split entry point demonstrates the complete attachment-source pattern:

- define the validated search RPC and attachment metadata in `shared/issues.ts`;
- handle it in the daemon subprocess from `server/issues.ts` and `index.server.ts`;
- register the attachment source from `index.client.ts`;
- keep credentials and vendor API calls out of the client bundle.
