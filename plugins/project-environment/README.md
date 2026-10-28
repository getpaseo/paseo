# Project environment

A standalone Paseo 0.13.2 plugin. This repository checkout predates its plugin API; the plugin has its own dependencies and typecheck and does not change Paseo core.

```sh
cd plugins/project-environment
npm ci --ignore-scripts
npm run typecheck
npm test
paseo plugin install "$PWD"
```

Enable plugins in Paseo Settings before installing. Open the Command Center in a workspace and choose **Project environment**. Save `EXAMPLE_API_KEY` and give a newly created agent this task:

> List project environment variables. Use the environment command tool to run code that reads EXAMPLE_API_KEY from its environment. Verify that the key is set without printing it.

For an API request, the agent can use an SDK's environment-based authentication or a command such as `curl -sS -H "Authorization: Bearer $EXAMPLE_API_KEY" https://your-api.example/resource`. Tool arguments contain variable references, never the key itself.

Update the value in the panel and repeat the command in the same agent. The executor reads the updated value on every call. The test file also verifies this against an actual local HTTP endpoint using the MCP client.

Dependencies use a committed lockfile. The local npm configuration enables legacy peer resolution because npm 10 crashes when resolving this SDK’s optional peer graph; the SDK, client, and protocol are pinned to the same Paseo release. The MCP SDK is pinned to 1.32.1, published more than seven days before this prototype, with no reported audit vulnerabilities at verification.

The broker retains its loopback port and workspace capability URLs across reloads. If another process takes the port, loading fails rather than redirecting old agents to a different endpoint. Do not copy the broker's private state into the repository.

See [OVERVIEW.md](OVERVIEW.md) for storage, provider setup, and security limits. Registry publication requires interface screenshots and a separate registry submission; this source is not published automatically.
