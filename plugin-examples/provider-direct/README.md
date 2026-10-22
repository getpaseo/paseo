# Direct provider example

This plugin implements `ProviderRegistration` directly. It demonstrates connection negotiation,
catalog and session listing, session creation, prompt and command disposition, settings,
persistence and replay, archive actions, and an ordinary child session.

The provider emits versioned `provider-result` timeline items for its root and child sessions.
`index.client.tsx` registers the Zod schema and React Native renderer for those items. The server
and client share only the item kind and schema under `shared/`.

The provider receives Paseo host tools through `config.mcpServers`; it does not receive a second
callback tool API.
