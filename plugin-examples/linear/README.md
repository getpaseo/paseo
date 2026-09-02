# Linear plugin example

This example adds `Attach Linear issue` to the composer. Search by issue identifier
or title, then send a stable issue snapshot to the agent.

Set a personal API key in the daemon environment:

```bash
export LINEAR_API_KEY="lin_api_..."
```

Register the extension in `$PASEO_HOME/config.json`:

```json
{
  "pluginsEnabled": true,
  "plugins": {
    "linear": {
      "source": "directory",
      "path": "/absolute/path/to/paseo/plugin-examples/linear"
    }
  }
}
```

Restart the development daemon after changing its environment or plugin configuration.

The split entry point demonstrates the complete attachment-source pattern:

- define the validated search RPC and attachment metadata in `issues.shared.ts`;
- handle it in the daemon subprocess from `issues.server.ts`;
- wire both contributions from `index.ts`;
- keep credentials and vendor API calls out of the client bundle.
