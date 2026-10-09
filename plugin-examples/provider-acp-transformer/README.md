# ACP provider transformer example

This server plugin registers an ACP command through `runAcpProvider()`. The helper owns ACP process
and SDK details behind Paseo's callback-based provider connection.

`server/vendor-edit.ts` shows the intended extension seam: a focused transformer converts one
vendor tool payload into Paseo's ordinary file-edit shape. It does not translate the whole event
stream.

Replace the placeholder `example-acp --stdio` command with an installed ACP agent before enabling
the plugin.
