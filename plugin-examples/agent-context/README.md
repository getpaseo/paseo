# Agent context plugin example

This plugin adds **Attach agent transcript** to the composer attachment menu. Search for an
existing agent on the same Paseo host, then select it to add a durable transcript snapshot to the
draft. The snapshot remains usable after the source agent changes, the plugin is removed, or the
host disconnects.

The daemon creates the snapshot through the Paseo SDK. The generic attachment-source UI owns the
picker, pill, draft persistence, and submission; this plugin adds no composer-specific UI or
protocol fields.

Install it on Paseo 0.8 or newer:

```bash
paseo plugin add getpaseo/paseo:plugin-examples/agent-context
```

Turn on **Enable plugins** under **Settings → Plugins** before installing. Paseo plugins are trusted,
unsandboxed code; review a plugin and its updates before enabling it.

The plugin lists non-archived, top-level agents from the daemon where it is installed. It captures
snapshots only after you enter a search, then includes user and assistant messages plus fixed
tool-kind markers. Reasoning, tool inputs and outputs, provider tool names, and subagent logs are
excluded. Each snapshot is limited to 128 KiB and keeps the most recent context when the retained
timeline is larger.

Opening the picker does not read agent history. Enter a specific query before Paseo asks the
matching agents for snapshots. On current 0.8 daemons, timeline retrieval can hydrate an inactive
retained provider session; it does not start a turn.

Attachment sources are scoped to the composer's host, so this example does not transfer context
between daemons. Install the plugin on each host where you want to attach local agent context.
