# Paseo HarmonyOS Client

Native HarmonyOS (NEXT) client for Paseo, built with ArkTS + ArkUI.

## Status

🚧 **Phase 1 MVP — in progress**

- [x] Project scaffold & build configuration
- [x] WebSocket transport adapter (DaemonTransport)
- [x] Binary frame decoder (terminal opcodes)
- [x] Connection lifecycle + state model
- [x] Connect page (host/port/password)
- [x] Agent page shell (header + composer)
- [x] Terminal page shell
- [ ] Timeline store & stream model port
- [ ] Message list (virtualized, markdown)
- [ ] Terminal Canvas renderer
- [ ] Composer → send prompt integration

## Structure

```
entry/src/main/ets/
├── entryability/EntryAbility.ets      App entry point
├── transport/harmony-transport.ets     @ohos.net.webSocket → DaemonTransport
├── client/client-lifecycle.ets         DaemonClient wrapper, connect/disconnect
├── models/
│   ├── connection-model.ets            Reactive connection state (@Observed)
│   └── agent-model.ets                 Agent lifecycle state
├── pages/
│   ├── connect-page.ets                First screen: host, port, password
│   ├── agent-page.ets                  Main view: timeline + composer
│   └── terminal-page.ets               Terminal viewer
├── components/
│   └── connection-indicator.ets        Status badge
└── common/
    ├── theme.ets                       Design tokens (colors, spacing, fonts)
    ├── constants.ets                   App-wide constants
    └── icons.ets                       Unicode icon glyphs
```

## Prerequisites

- DevEco Studio 5.0+
- HarmonyOS SDK API 12+
- Node.js (for workspace npm dependencies)

## Build

```bash
# 1. Build workspace npm dependencies (from repo root)
npm run build:app-deps

# 2. Open in DevEco Studio
# File → Open → packages/harmony

# 3. Or build via CLI
hvigorw assembleHap
```

## Dependencies

| Package | Source | Purpose |
|---------|--------|---------|
| `@getpaseo/client` | monorepo | Daemon WebSocket driver + RPC |
| `@getpaseo/protocol` | monorepo | Wire schemas, message types |
| `@getpaseo/highlight` | monorepo | Code syntax highlighting |
| `markdown-it` | npm | Markdown → token parsing |
| `zod` | npm | Runtime schema validation |
| `mnemonic-id` | npm | Human-readable IDs |

All are pure TypeScript packages with no DOM or Node.js dependencies,
importable directly into ArkTS.
