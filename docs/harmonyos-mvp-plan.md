# HarmonyOS MVP Implementation Plan — Phase 1

## Overview

ArkUI (ArkTS) native rewrite of the Paseo mobile app for HarmonyOS. Core SDK packages
(`@getpaseo/client`, `@getpaseo/protocol`, `@getpaseo/highlight`) are reused as npm
dependencies. The UI layer is rebuilt from scratch using the ArkUI declarative framework,
with platform capabilities provided by native `@ohos.*` APIs.

**Scope of Phase 1:** Connect to daemon → view agent stream → send prompt → terminal.
A working mobile client that can monitor and interact with a single agent session.

**Estimated total:** ~8,000 lines ArkTS, 3–4 weeks (1 developer).

---

## Repository Structure

```
packages/harmony/                  # New top-level package
├── oh-package.json5               # HarmonyOS package manifest (references npm deps)
├── build-profile.json5
├── hvigorfile.ts
├── entry/                         # Main module
│   └── src/main/
│       ├── ets/
│       │   ├── entryability/
│       │   │   └── EntryAbility.ets
│       │   ├── transport/         # WebSocket → DaemonTransport adapter
│       │   │   └── harmony-transport.ets          (~100 lines)
│       │   ├── client/            # Thin wrapper around @getpaseo/client
│       │   │   ├── paseo-client-context.ets        (~150 lines)
│       │   │   └── client-lifecycle.ets            (~120 lines)
│       │   ├── models/            # ArkTS-idiomatic state models
│       │   │   ├── agent-model.ets                 (~200 lines)
│       │   │   ├── stream-model.ets                (~400 lines)
│       │   │   ├── timeline-store.ets              (~350 lines)
│       │   │   └── connection-model.ets            (~150 lines)
│       │   ├── pages/             # Route-level pages
│       │   │   ├── connect-page.ets                (~250 lines)
│       │   │   ├── agent-page.ets                  (~120 lines)
│       │   │   └── terminal-page.ets               (~80 lines)
│       │   ├── components/        # UI components
│       │   │   ├── message-list.ets                (~500 lines)
│       │   │   ├── message-item.ets                (~350 lines)
│       │   │   ├── markdown-block.ets              (~500 lines)
│       │   │   ├── code-block.ets                  (~200 lines)
│       │   │   ├── tool-call-card.ets              (~300 lines)
│       │   │   ├── agent-header.ets                (~200 lines)
│       │   │   ├── composer-bar.ets                (~400 lines)
│       │   │   ├── terminal-canvas.ets             (~800 lines)
│       │   │   ├── terminal-toolbar.ets            (~120 lines)
│       │   │   └── connection-indicator.ets        (~100 lines)
│       │   ├── terminal/          # Terminal emulation
│       │   │   ├── terminal-buffer.ets             (~450 lines)
│       │   │   ├── terminal-parser.ets             (~350 lines)
│       │   │   ├── terminal-renderer.ets           (~400 lines)
│       │   │   └── terminal-colors.ets             (~80 lines)
│       │   └── common/            # Shared utilities
│       │       ├── theme.ets                       (~150 lines)
│       │       ├── icons.ets                       (~80 lines)
│       │       └── constants.ets                   (~60 lines)
│       └── resources/
│           ├── base/element/
│           ├── dark/element/
│           └── rawfile/
├── harness/                       # Test harness
│   └── test/
│       └── ets/
│           └── transport/
│               └── harmony-transport.test.ets
└── README.md
```

---

## Task Breakdown

### T1 — Project scaffold & build chain (Day 1)

Bootstrap a standard HarmonyOS application project. Configure npm resolution so that
`@getpaseo/protocol` and `@getpaseo/client` (both pure ESM) are consumable from ArkTS.
ArkTS is a TypeScript superset and can import `.js` and `.d.ts` files directly, but
npm package resolution under `oh-package.json5` requires explicit mapping.

**Deliverable:**
- `npm run dev:harmony` launches DevEco Studio or `hdc` deployable artifact
- `import { DaemonClient } from '@getpaseo/client'` compiles in ArkTS
- `import { SessionInboundMessageSchema } from '@getpaseo/protocol/messages'` works

**Key decisions:**
- Verify that `zod` (dependency of `@getpaseo/client` and `@getpaseo/protocol`) works
  in the ArkTS runtime. Zod v4 targets ESM/TC39 only — no DOM or Node deps — so it
  should be fine, but this is the first thing to validate.
- If `zod` doesn't work, fall back to bundling protocol types as pre-generated TS
  interfaces with manual validation (the protocol package already emits `.d.ts`).

---

### T2 — WebSocket transport adapter (Day 1–2)

```typescript
// transport/harmony-transport.ets
// Adapt @ohos.net.webSocket to the DaemonTransport interface

import webSocket from '@ohos.net.webSocket';
import type { DaemonTransport } from '@getpaseo/client/internal/daemon-client-transport-types';

export function createHarmonyTransport(url: string): DaemonTransport {
  const ws = webSocket.createWebSocket();

  return {
    send(data: string | Uint8Array | ArrayBuffer): void {
      // Binary frames (terminal) → ArrayBuffer
      // JSON frames (session messages) → string
      ws.send(data);
    },
    close(code?: number, reason?: string): void {
      ws.close({ code: code ?? 1000, reason: reason ?? '' });
    },
    onMessage(handler: (data: unknown) => void): () => void {
      ws.on('message', (_err: Error | null, value: string | ArrayBuffer) => {
        handler(value);
      });
      return () => ws.off('message');
    },
    onOpen(handler: () => void): () => void {
      ws.on('open', handler);
      return () => ws.off('open');
    },
    onClose(handler: (event?: unknown) => void): () => void {
      ws.on('close', (_err: Error | null, value: unknown) => handler(value));
      return () => ws.off('close');
    },
    onError(handler: (event?: unknown) => void): () => void {
      ws.on('error', (err: Error) => handler(err));
      return () => ws.off('error');
    },
  };
}
```

**Key decision:** Paseo sends terminal output as **binary WebSocket frames** (opcode +
slot + payload). The RN web client uses `ws.binaryType = 'arraybuffer'` and receives
`MessageEvent.data` as ArrayBuffer. HarmonyOS `@ohos.net.webSocket` emits `message`
callbacks with `string | ArrayBuffer` — confirm ArrayBuffer binary frame support and
route JSON vs binary messages correctly in the message handler.

**Deliverable:**
- Unit test that connects to a local daemon (`npm run dev`) and parses a `server_info`
  status message
- Unit test that receives a binary terminal output frame and extracts opcode + payload

---

### T3 — Paseo client context & lifecycle (Day 2–3)

Wrap `DaemonClient` with ArkUI-friendly state management. Every page needs access to:
- Connection state (idle / connecting / connected / disconnected)
- Server info (serverId, hostname, version, features)
- The `DaemonClient` instance for RPC calls

Use ArkUI's `@Observed` / `@ObjectLink` pattern for reactivity, or a simple
event-emitter pattern if the decorator model doesn't fit the async WebSocket lifecycle.

```typescript
// client/paseo-client-context.ets
import { DaemonClient } from '@getpaseo/client';
import type { ServerInfoStatusPayload } from '@getpaseo/protocol/messages';

@Observed
export class ConnectionState {
  status: 'idle' | 'connecting' | 'connected' | 'disconnected' = 'idle';
  serverId: string = '';
  hostname: string = '';
  version: string = '';
}

export class PaseoClientContext {
  client: DaemonClient | null = null;
  state: ConnectionState = new ConnectionState();

  async connect(host: string, port: number): Promise<void> { ... }
  disconnect(): void { ... }
  // RPC wrappers for common operations
  async createAgent(config: CreateAgentConfig): Promise<string> { ... }
  async sendMessage(agentId: string, text: string): Promise<void> { ... }
}
```

**Deliverable:**
- Connect to a user-specified daemon address
- Display connection status indicator
- Store last-used host in `@ohos.data.preferences`

---

### T4 — Connect page (Day 3)

```
┌──────────────────────────────┐
│         Paseo                │
│                              │
│   ┌──────────────────────┐   │
│   │  Host (IP:port)      │   │
│   │  192.168.1.5:6767    │   │
│   └──────────────────────┘   │
│                              │
│   ┌──────────────────────┐   │
│   │  Password (optional) │   │
│   └──────────────────────┘   │
│                              │
│   ┌──────────────────────┐   │
│   │     Connect          │   │
│   └──────────────────────┘   │
│                              │
│   Recent connections:        │
│   • 192.168.1.5:6767        │
│   • home-server.local:6767  │
└──────────────────────────────┘
```

Simple `Column` layout with `TextInput` for host/port/password, `Button` for connect.
On successful connection → navigate to agent page.

---

### T5 — Timeline store & stream model (Day 3–5)

This is the most logic-heavy piece. Port the core concepts from
`timeline/session-stream-reducers.ts` (1,240 lines) and `agent-stream/model.ts` to a
reactive ArkUI model.

The key functions to extract:

| Source file | Function | What it does |
|------------|----------|-------------|
| `session-stream-reducers.ts` | `processTimelineResponse()` | Merges incoming timeline pages into tail/head arrays with dedup, gap detection, cursor tracking |
| `session-stream-reducers.ts` | `classifySessionTimelineSeq()` | Sequence-number dedup logic |
| `agent-stream/model.ts` | `buildAgentStreamRenderModel()` | Splits items into virtualized-history / mounted-history / live-head segments |
| `types/stream.ts` | `reduceStreamUpdate()` | Normalizes individual `AgentStreamEventPayload` into `StreamItem` |

**Strategy:** These functions are pure TypeScript with no React dependency —
they operate on `StreamItem[]` arrays. Extract them into a shared `models/timeline-core.ts`
that directly translates the algorithm, then wrap the output in ArkUI reactive state.

```typescript
// models/timeline-store.ets
import type { StreamItem } from '../../../app/src/types/stream'; // reference types
import { processTimelineResponse } from './timeline-core';
import type { TimelineCursor, ProcessTimelineResponseOutput } from './timeline-core';

@Observed
export class TimelineStore {
  tail: StreamItem[] = [];
  head: StreamItem[] = [];
  cursor: TimelineCursor | undefined;
  isLoading: boolean = false;

  applyPage(response: TimelineResponse): void {
    const result = processTimelineResponse({
      payload: response,
      currentTail: this.tail,
      currentHead: this.head,
      currentCursor: this.cursor,
      ...
    });
    this.tail = result.tail;
    this.head = result.head;
    this.cursor = result.cursor ?? undefined;
  }

  appendStreamEvent(event: AgentStreamEventPayload): void {
    // Live stream events append directly to head
    this.head = [...this.head, reduceStreamUpdate(this.head, event)];
  }
}
```

**Deliverable:**
- Port `processTimelineResponse` and dependencies (~400 lines pure logic)
- Unit test with known timeline payloads from existing RN tests
- Reactive store that triggers UI updates on new data

---

### T6 — Message list component (Day 5–7)

The main scroll view that renders `StreamItem[]`. ArkUI `List` + `LazyForEach` for
virtualization (built-in, no third-party library needed).

```
┌──────────────────────────────┐
│ ← Agent: paseo-setup-tj37   │  ← agent-header
├──────────────────────────────┤
│ You: Fix the login bug       │  ← message-item (user_message)
│                              │
│ Claude: I'll investigate...  │  ← message-item (assistant_message)
│                              │
│ ┌─ Tool: Read ────────────┐  │
│ │ src/auth/login.ts       │  │  ← tool-call-card
│ │ ...                     │  │
│ └──────────────────────────┘  │
│                              │
│ Claude: Found the issue...   │  ← message-item
│                              │
│ ┌──────────────────────────┐  │
│ │  Send a message...       │  │  ← composer-bar
│ └──────────────────────────┘  │
└──────────────────────────────┘
```

**Components:**

| Component | Lines | Description |
|-----------|-------|-------------|
| `message-list.ets` | ~500 | `List` with `LazyForEach`, scroll-to-bottom, loading indicator |
| `message-item.ets` | ~350 | Dispatches to markdown-block or tool-call-card based on `item.kind` |
| `markdown-block.ets` | ~500 | Renders parsed markdown AST → `RichText`/`Span`/`ImageSpan` (covers: headings, paragraphs, inline code, bold/italic, links, images) |
| `code-block.ets` | ~200 | Code fences with syntax highlighting (uses `@getpaseo/highlight`) and copy button |
| `tool-call-card.ets` | ~300 | Expandable card showing tool name + truncated result |
| `agent-header.ets` | ~200 | Agent title, status badge, kebab menu |

**Markdown rendering approach:**

1. `markdown-it` parses text → token array (reuse from npm, pure JS)
2. Walk tokens recursively in ArkTS
3. Map each token type to ArkUI components:
   - `heading` → `Text` with fontSize/weight
   - `paragraph` → `Text`
   - `code_inline` → `Text` with monospace font + background
   - `fence` → `code-block` component
   - `list_item` → `Row` + `Text`
   - `link` → `Text` with blue color + `onClick` → open browser
4. Diff blocks (Paseo uses custom diff syntax in code fences) → extend code-block

**Deliverable:**

- Scrollable message list with lazy loading
- Correct rendering of: user messages, assistant markdown, code blocks with
  syntax highlighting, tool call cards, and turn boundaries
- Scroll-to-bottom on new content (with bottom-anchor logic from
  `agent-stream/bottom-anchor-controller.ts` ported)
- Auto-load older pages on scroll-to-top (pagination)

---

### T7 — Terminal emulation & canvas renderer (Day 7–10)

Paseo's terminal is the hardest component. The RN version uses either:
- **web (desktop/browser):** xterm.js addons in a `<webview>`
- **native (iOS/Android):** a custom `Text`-based line renderer in
  `components/terminal-emulator.native.tsx`

For HarmonyOS, build a **Canvas-based terminal renderer**.

**Architecture:**

```
binary WS frame
      │
      ▼
┌─────────────────┐
│ terminal-parser  │  ← decodes opcode + payload (output / snapshot / resize)
│   (~350 lines)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ terminal-buffer  │  ← grid of characters + attributes (fg/bg/bold/inverse)
│   (~450 lines)   │     cursor position, scrollback, scroll region
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│ terminal-renderer    │  ← Canvas drawing loop
│   (~400 lines)       │     draws character grid from buffer
│                      │     handles dirty rects for perf
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ terminal-canvas.ets  │  ← ArkUI Canvas component
│   (~800 lines)       │     keyboard input → WebSocket send
│                      │     gesture (pinch-zoom font, swipe tabs)
│                      │     resize → binary resize frame
└─────────────────────┘
```

**Terminal buffer data structures:**

```typescript
interface TerminalChar {
  char: string;       // UTF-8 code point
  fg: number;         // foreground color index
  bg: number;         // background color index
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

interface TerminalBuffer {
  rows: number;
  cols: number;
  lines: TerminalChar[][];    // ring buffer, [0] = topmost scrollback
  cursorRow: number;
  cursorCol: number;
  scrollTop: number;          // scroll region
  scrollBottom: number;
  cursorVisible: boolean;
  // Cursor save/restore, alternate screen, etc. — only implement what Paseo actually uses
}
```

**Terminal parser (subset of xterm escape sequences):**

Paseo terminals receive from agent PTY output. Only need a subset:

| Sequence | What | Priority |
|----------|------|----------|
| `\n`, `\r`, `\r\n` | Line feed / carriage return | P0 |
| `\b` | Backspace | P0 |
| `\t` | Tab | P0 |
| `\x1b[K`, `\x1b[0K`... | Erase line | P0 |
| `\x1b[J`, `\x1b[0J`... | Erase display | P0 |
| `\x1b[?25h` / `\x1b[?25l` | Cursor show/hide | P0 |
| `\x1b[nA`, `\x1b[nB`... | Cursor movement | P1 |
| `\x1b[n;mH` | Cursor position | P1 |
| `\x1b[m`, `\x1b[0m`... | SGR (colors/attributes) | P1 |
| `\x1b[?1049h` / `\x1b[?1049l` | Alternate screen | P1 |
| `\x1b[?47h` / `\x1b[?47l` | Alternate screen (older) | P2 |
| `\x1b[6n` | Cursor position report | P2 |
| `\x1b]0;...\x07` | Set window title | P2 |

**Canvas rendering:**

```typescript
// terminal-renderer.ets
class TerminalRenderer {
  private ctx: CanvasRenderingContext2D;
  private font: string;
  private charWidth: number;
  private charHeight: number;
  private dirtyRows: Set<number> = new Set();

  // Theme colors (Paseo dark / light themes)
  private colors: TerminalColors;

  drawRow(row: number): void {
    const y = row * this.charHeight;
    for (let col = 0; col < this.cols; col++) {
      const ch = buffer.line[row][col];
      this.ctx.fillStyle = this.colors.bg[ch.bg];
      this.ctx.fillRect(col * this.charWidth, y, this.charWidth, this.charHeight);
      this.ctx.fillStyle = this.colors.fg[ch.fg];
      this.ctx.font = ch.bold ? `bold ${this.font}` : this.font;
      this.ctx.fillText(ch.char, col * this.charWidth, y + this.charHeight * 0.8);
    }
  }

  renderFrame(): void {
    if (this.dirtyRows.size === 0) return;
    for (const row of this.dirtyRows) {
      this.drawRow(row);
    }
    this.dirtyRows.clear();
  }
}
```

**Deliverable:**

- Terminal canvas that renders ANSI-escaped text output
- Scrollback buffer (~1000 lines)
- Keyboard input forwarded to daemon
- Resize detection → binary resize frame
- Theme parity with Paseo dark/light themes
- Snapshot restore on reconnect (`terminal_snapshot` message)

---

### T8 — Composer bar (Day 10–11)

Bottom input area for sending prompts.

```
┌──────────────────────────────────┐
│ ┌──────────────────────────────┐ │
│ │ Send a message...            │ │  ← TextArea, grows to max 5 lines
│ └──────────────────────────────┘ │
│ [model ▾] [mode ▾]        [Send] │  ← agent-controls row
└──────────────────────────────────┘
```

Uses ArkUI `TextArea` with `maxLines(5)`. `KeyboardAvoidMode.RESIZE` for keyboard
handling (built into ArkUI, no third-party library needed).

**Features:**
- Multi-line input with auto-grow (up to 5 lines)
- Send button + Enter key submit (Shift+Enter for newline)
- Provider/model/mode selectors (slide-up picker sheets)

Reference RN files: `composer/input/input.tsx`, `composer/draft/input-draft.ts`,
`composer/agent-controls/`.

---

### T9 — Agent page assembly (Day 11–12)

Put it all together into the main agent interaction page.

**Layout:**
```
┌──────────────────────────────┐
│ NavigationBar                │  ← Back, agent title, connection indicator
├──────────────────────────────┤
│                              │
│       message-list           │  ← Scrollable timeline
│                              │
├──────────────────────────────┤
│       composer-bar           │  ← Pinned to bottom
└──────────────────────────────┘
```

**Route:** `agent-page.ets` receives `agentId` via router params, loads agent state
from daemon, subscribes to `agent_stream` and `agent_update` session messages.

**Navigation structure (Phase 1):**
```
ConnectPage → AgentPage
                 ├── TerminalPage (push via router)
                 └── (future: SettingsPage, FileExplorer, etc.)
```

ArkUI router API: `router.pushUrl({ url: 'pages/terminal-page', params: { ... } })`

---

### T10 — Buffering, polish, and edge cases (Day 12–14)

- Connection loss → reconnect with backoff, show banner
- Empty state → "No agents running" placeholder
- Loading state → skeleton/spinner
- Error state → inline error message
- Theme → dark mode support (ArkUI `dark/` resource directory)
- Performance → verify `LazyForEach` works for 1000+ timeline items
- Keyboard → `KeyboardAvoidMode.RESIZE` works correctly with composer bar
- Terminal → verify binary frame handling on real device

---

## Dependency Matrix

### Reused as npm (zero changes)

| Package | Lines | Integration |
|---------|-------|-------------|
| `@getpaseo/client` | 12,765 | Import `DaemonClient`, `DaemonTransport` interface |
| `@getpaseo/protocol` | 15,363 | Import Zod schemas, message types, lifecycle types |
| `@getpaseo/highlight` | 978 | Import `Highlighter` for code blocks |
| `markdown-it` | (npm) | Import for markdown → token parsing |
| `zod` | (npm) | Runtime validation (verify ArkTS compatibility) |
| `mnemonic-id` | (npm) | Generate readable agent IDs |

### Replaced by @ohos.* APIs (no third-party deps)

| RN dependency | HarmonyOS replacement |
|---------------|----------------------|
| React Native View/Text | ArkUI `Column`/`Row`/`Text`/`List` |
| Expo Router | `@ohos.router` |
| `@tanstack/react-virtual` | `LazyForEach` (built-in) |
| `react-native-reanimated` | `animateTo()` / property animation (built-in) |
| `react-native-gesture-handler` | `gesture()` API (built-in) |
| `@gorhom/bottom-sheet` | `bindSheet` (built-in) |
| `react-native-safe-area-context` | `expandSafeArea` / `safeAreaInsets` (built-in) |
| `react-native-keyboard-controller` | `KeyboardAvoidMode` (built-in) |
| AsyncStorage | `@ohos.data.preferences` |
| `expo-clipboard` | `@ohos.pasteboard` |
| `expo-linking` | `@ohos.router` / `openLink` |
| react-native-svg | Not needed (use Image for icons) |

### Implemented from scratch

| Module | Lines | Priority |
|--------|-------|----------|
| Harmony WebSocket transport | ~100 | P0 |
| Timeline store (reactive wrapper) | ~350 | P0 |
| Timeline core logic (port) | ~400 | P0 |
| Stream model (port) | ~200 | P0 |
| Terminal parser | ~350 | P0 |
| Terminal buffer | ~450 | P0 |
| Terminal canvas renderer | ~400 | P0 |
| Terminal UI component | ~800 | P0 |
| Message list | ~500 | P0 |
| Message item | ~350 | P0 |
| Markdown renderer | ~500 | P0 |
| Code block | ~200 | P0 |
| Tool call card | ~300 | P0 |
| Composer bar | ~400 | P0 |
| Agent header | ~200 | P0 |
| Connect page | ~250 | P0 |
| Agent page | ~120 | P0 |
| Terminal page | ~80 | P0 |
| Connection indicator | ~100 | P1 |
| Theme system | ~150 | P1 |
| Icons | ~80 | P1 |
| Client context | ~150 | P1 |
| Client lifecycle | ~120 | P1 |
| Agent model | ~200 | P2 |
| Connection model | ~150 | P2 |
| Constants | ~60 | P2 |
| **Total** | **~7,800** | |

---

## Files NOT ported in Phase 1

These Paseo features are deferred to Phase 2+:

| Feature | Files skipped | Reason |
|---------|-------------|--------|
| Git diff / PR pane | `git/` (~8,500 lines) | Requires FileExplorer, diff rendering — Phase 2 |
| File explorer | `file-explorer/` | Phase 2 |
| Workspace management | `workspace/`, `projects/` | Phase 2 (Phase 1: single agent view) |
| Voice agent | `voice/` (~2,200 lines) | Requires `expo-two-way-audio` → `@ohos.multimedia.audio` rewrite |
| Notifications | `expo-notifications` | Requires Push Kit integration |
| Camera / QR pairing | `screens/` pairing flows | Requires ScanKit |
| Settings pages | `screens/settings/` (~4,000 lines) | Phase 2 |
| Dark/light toggle | `use-color-scheme` | Phase 2 (default dark) |
| Drag-and-drop reorder | `react-native-draggable-flatlist` | Phase 2 |
| Hardware keyboard | `paseo-hardware-keyboard` | Tablet-only feature |
| Browser pane | `browser-pane.electron.tsx` | Desktop-only feature |
| i18n (multi-locale) | `i18n/` (15,834 lines) | Phase 2 (English-only for MVP) |

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `zod` incompatible with ArkTS runtime | Blocks protocol validation | Pre-generate TS interfaces; validate manually if needed |
| `@ohos.net.webSocket` binary frame handling differs | Blocks terminal | Test binary frames on Day 1; fall back to base64-in-JSON if needed |
| Canvas text rendering perf on real device | Terminal sluggish | Use `OffscreenCanvas` if available; batch draws; measure on device |
| `markdown-it` bundle size or runtime issues | Slow markdown rendering | Pre-parse on a worker or simplify to regex-based parser |
| ArkUI `List` + `LazyForEach` perf with mixed content | Scrolling jank | Verify with 500+ items on real device; consider flat list if needed |
| npm package resolution in ArkTS project | Can't import client packages | Use `ohpm` registry mapping or local tarball; validate Day 1 |

---

## Day-by-day Schedule

| Day | Tasks | Status |
|-----|-------|--------|
| 1 | T1 (scaffold) + T2 (transport) | ✅ Done |
| 2 | T2 (transport tests) + T3 (client context) | ✅ Done |
| 3 | T4 (connect page) + T5 (stream types + timeline core) | ✅ Done |
| 4 | T5 (timeline store) | ✅ Done |
| 5 | T6 (message item + markdown + code + tool card) | ✅ Done |
| 6 | T6 (message list + agent header) + T8 (composer integrated) | ✅ Done |
| 7 | T7 (terminal buffer + parser + renderer) | ✅ Done |
| 8 | T7 (terminal canvas + toolbar + page integration) | ✅ Done |
| 9 | T9 (agent page assembly with real components) | ✅ Done |
| 10–14 | Integration with daemon RPCs, real-device testing, polish | 📋 Pending |

**Actual:** 4,134 lines ArkTS + 151 lines config, 32 source files. All Phase 1 components implemented.
