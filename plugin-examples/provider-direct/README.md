# Direct provider example

This server-only plugin implements `ProviderRegistration` directly. It demonstrates connection
negotiation, catalog and session listing, session creation, prompt and command disposition,
settings, persistence and replay, reload, archive actions, and an ordinary child session carrying a
plugin timeline item.

The provider receives Paseo host tools through `config.mcpServers`; it does not receive a second
callback tool API.
