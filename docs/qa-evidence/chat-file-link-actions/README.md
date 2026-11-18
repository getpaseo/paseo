# Chat file link actions

Related workflow: [discussion #6130](https://github.com/getpaseo/paseo/discussions/6130).

Right-click a file link, or use Shift+F10 on the focused link. The menu offers the existing file preview, an absolute path copy, the containing folder in Paseo, a download, and the local desktop file manager where available. Reloaded conversation history uses the same renderer. Native clients open the menu on a link long press.

The native Markdown patch preserves the pressed occurrence's syntax through long-press events, including GFM paragraphs, quotes and tables. This keeps URL decoding distinct from literal percent characters in recognized inline code.

## Recorded browser verification

These recordings use a real browser, an isolated real daemon and the existing mock agent provider. File operations and the clipboard are real; the network transport is not mocked.

- [Copy a path from reloaded conversation history](copy-history.webm).
- [Reveal the containing folder and select the file in Paseo](reveal-folder.webm).
- [Download the linked binary](download.webm).
- [Compact menu presentation](compact.webm).

The compact recording exercises the web layout at 390 × 844. It is not evidence of an Android or iOS device run.

The recordings retain test setup and teardown. The temporary workspace is removed at the end of each test, so a final “Workspace unavailable” screen is teardown, not the action result.

## Commands and results

From `packages/app`:

```text
npm exec -- vitest run src/assistant-file-links/parse.test.ts --bail=1
Test Files  1 passed (1)
Tests       47 passed (47)

npm exec -- vitest run src/assistant-file-links/use-file-link.test.tsx --bail=1
Test Files  1 passed (1)
Tests       6 passed (6)
```

The added file URL line-range test failed before the parser change: the returned path retained `:12-18`, with both line fields undefined. It passes after the fix. The existing hook suite covers resolution caching and context changes.

From the repository root, with `E2E_RECORD_VIDEO=1`:

```text
npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/assistant-file-link-actions.spec.ts --max-failures=1
7 passed (1.2m)

npm run typecheck --workspace=@getpaseo/app
tsgo --noEmit
Exit code: 0

npm run build:main --workspace=@getpaseo/desktop
tsc -p tsconfig.json
Exit code: 0

npm run lint -- <changed app files>
Found 0 warnings and 0 errors.

node node_modules/react-native/scripts/generate-codegen-artifacts.js -p packages/app -t all -o .dev/file-link-codegen -f
[Codegen] Done.
Exit code: 0
```

The browser cases cover reloaded history, decoded names with spaces and accents, removal of line suffixes, keyboard access and focus restoration, selection in the file tree, binary download, a missing-path error followed by a successful retry, ordinary web links and a compact menu.

The dependency patch was also checked with `git apply --check -p3` against the original published package. The new Android long-press regression was added to the existing `InlineCodeFormattingTest` suite but has not been run here.

## Windows desktop verification

A separate Electron 44.2.0 development instance used the changed application source, a fresh user-data directory and its own daemon home and random port. Choosing the actual **Reveal in Explorer** menu item invoked the production desktop bridge. Windows Shell COM confirmed that Explorer had selected the requested `docs/report.md`, without the link's `:12` suffix. Neither the desktop bridge nor the OS handoff was mocked.

The final check ran with its window hidden. Screenshots cannot be captured reliably in that mode, so the recordings above show the browser UI instead. The installed personal Paseo instance and its daemon were not restarted.

## Platform coverage and remaining validation

| Platform               | Coverage                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Browser web on Windows | Seven real daemon/browser scenarios; wide and compact layouts                             |
| Windows Electron       | Actual local Explorer selection confirmed; desktop build passed                           |
| Android                | Native event schema generation only; no device or emulator run; native regression not run |
| iOS                    | Native event schema generation only; no Xcode build or device run                         |
| Linux desktop          | Not run; uses the existing desktop file-manager target                                    |
| macOS desktop          | Not run; uses the existing desktop file-manager target                                    |

Native long-press presentation, cross-paragraph text selection, dismissal before sharing and navigation, and scroll performance still need device verification. No native performance measurement is claimed. Keep the contribution in draft until that validation is complete.

Paseo's file tree can reveal files inside the current workspace. A link outside it reports that limitation for **Reveal in Paseo**; the path copy, existing download flow and local OS reveal remain separate actions. Remote daemon files never use the local OS reveal action. No new daemon RPC or protocol field is introduced.
