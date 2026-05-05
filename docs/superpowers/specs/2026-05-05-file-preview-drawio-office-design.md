# File Preview Drawio Office Design

## Goal

Add local workspace file previews for `.drawio`, `.drawio.xml`, `.docx`, `.xlsx`, and `.xls`, with draw.io editing and save-back support.

## Scope

- Draw.io files open in a file tab, render through the diagrams.net embed surface, allow editing, and save the updated XML back to the same workspace path.
- Word and Excel files open in a file tab and render read-only previews using client-side libraries.
- File bytes stay local to the connected daemon/app. The Office preview path does not use Microsoft, Google, or other hosted document viewers.
- Password-protected Office files, macros, formula execution, collaborative editing, and draw.io conflict resolution UI are out of scope.

## Architecture

The server keeps the workspace boundary as the authority. Existing file reads continue through `file_explorer_request`; a new save request writes base64 bytes to a path after resolving it under the workspace root and optionally checking the previously loaded size and modified time.

The app keeps file tabs as the entry point. `FilePane` chooses a specialized preview mode by file extension: draw.io editor, DOCX preview, spreadsheet preview, or the existing text/image/binary preview. Platform-specific renderer files carry DOM/iframe/WebView code so native bundles do not import raw DOM APIs.

## Components

- Server file service: add a write helper beside `readExplorerFileBytes`.
- Shared messages and daemon client: add backward-compatible file save request/response shapes and a `saveFile` client method.
- File preview mode utility: centralize extension detection for markdown, draw.io, Word, and spreadsheet files.
- Draw.io preview component: embed diagrams.net, load XML, receive save events, and call `client.saveFile`.
- DOCX preview component: use `docx-preview` to render bytes into a local container.
- Spreadsheet preview component: use SheetJS `xlsx` to render workbook sheets into a read-only table view.

## Error Handling

The server rejects empty cwd, paths outside the workspace, non-file parents, and optional stale-write checks. The client shows existing center-state errors when reads fail and a compact save error in the draw.io toolbar when writes fail.

## Testing

Use targeted tests only:

- `packages/server/src/shared/messages.test.ts`
- `packages/server/src/server/file-explorer/service.test.ts`
- `packages/server/src/client/daemon-client.test.ts`
- `packages/server/src/server/session.test.ts`
- `packages/app/src/components/file-pane-render-mode.test.ts`
