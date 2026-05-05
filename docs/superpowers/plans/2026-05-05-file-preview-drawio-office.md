# File Preview Drawio Office Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add draw.io preview/edit/save and local read-only DOCX/XLSX previews in workspace file tabs.

**Architecture:** Extend the existing file tab and file explorer read path rather than adding a new navigation surface. The server owns scoped workspace writes; the app owns extension-based renderer selection and third-party rendering libraries.

**Tech Stack:** TypeScript, React Native/React Native Web, `react-native-webview`, diagrams.net embed mode, `docx-preview`, SheetJS `xlsx`, Vitest.

---

### Task 1: Workspace File Save Protocol

**Files:**

- Modify: `packages/server/src/shared/messages.ts`
- Modify: `packages/server/src/shared/messages.test.ts`
- Modify: `packages/server/src/server/file-explorer/service.ts`
- Modify: `packages/server/src/server/file-explorer/service.test.ts`
- Modify: `packages/server/src/client/daemon-client.ts`
- Modify: `packages/server/src/client/daemon-client.test.ts`
- Modify: `packages/server/src/server/session.ts`
- Modify: `packages/server/src/server/session.test.ts`

- [ ] Add failing tests for `workspace_file_save_request`, scoped writes, stale checks, client request/response, and session handling.
- [ ] Run the targeted server tests and confirm they fail because the save API does not exist.
- [ ] Add schemas and types with optional compatibility fields.
- [ ] Add a scoped write helper that accepts base64 content and returns path, size, and modified time.
- [ ] Add `DaemonClient.saveFile`.
- [ ] Route the message through `Session`.
- [ ] Run the targeted tests and confirm they pass.

### Task 2: Preview Mode Routing

**Files:**

- Modify: `packages/app/src/components/file-pane-render-mode.ts`
- Modify: `packages/app/src/components/file-pane-render-mode.test.ts`

- [ ] Add failing tests for draw.io, docx, xlsx, and existing markdown behavior.
- [ ] Implement `getWorkspaceFilePreviewMode(filePath)`.
- [ ] Run the targeted app test and confirm it passes.

### Task 3: Third-Party Preview Components

**Files:**

- Modify: `packages/app/package.json`
- Modify: `package-lock.json`
- Create: `packages/app/src/components/workspace-file-previews/drawio-preview.web.tsx`
- Create: `packages/app/src/components/workspace-file-previews/drawio-preview.native.tsx`
- Create: `packages/app/src/components/workspace-file-previews/drawio-preview.tsx`
- Create: `packages/app/src/components/workspace-file-previews/docx-preview.web.tsx`
- Create: `packages/app/src/components/workspace-file-previews/docx-preview.native.tsx`
- Create: `packages/app/src/components/workspace-file-previews/spreadsheet-preview.web.tsx`
- Create: `packages/app/src/components/workspace-file-previews/spreadsheet-preview.native.tsx`

- [ ] Install `docx-preview` and `xlsx` in `@getpaseo/app`.
- [ ] Add focused renderer components using the libraries, with native WebView fallbacks where needed.
- [ ] Keep DOM access inside `.web.tsx` files and WebView HTML inside `.native.tsx` files.

### Task 4: FilePane Integration

**Files:**

- Modify: `packages/app/src/components/file-pane.tsx`

- [ ] Route special preview modes before existing text/image/binary rendering.
- [ ] Pass bytes, metadata, and save callback to draw.io.
- [ ] Keep existing previews unchanged for all other files.

### Task 5: Verification

**Files:**

- All modified files.

- [ ] Run targeted Vitest files touched by the change.
- [ ] Run `npm run build:daemon` if generated daemon declarations are needed.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run format`.
- [ ] Run `npm run format:check`.
