# Code navigation

Hold Cmd (macOS) or Ctrl and hover a symbol in a file tab: it underlines. Click it and Paseo
opens the declaration at its line. The daemon answers by talking to a real language server over
LSP, so resolution matches what your editor does.

## Paseo ships no language servers

Binaries are the user's to install. A workspace whose server is missing reports the command to
install once per file view and otherwise stays quiet — an absent server is a normal state, not an
error.

| Language       | Server                       | Install                                      |
| -------------- | ---------------------------- | -------------------------------------------- |
| TypeScript, JS | `typescript-language-server` | `npm i -g typescript-language-server`        |
| Python         | `pyright-langserver`         | `npm i -g pyright`                           |
| Go             | `gopls`                      | `go install golang.org/x/tools/gopls@latest` |
| Rust           | `rust-analyzer`              | `rustup component add rust-analyzer`         |

Paseo looks for the command on the daemon's PATH. When it lives somewhere else, point at it in
`$PASEO_HOME/config.json` and run `paseo reload`:

```json
{
  "daemon": {
    "codeNavigation": {
      "servers": {
        "typescript": "/opt/homebrew/bin/typescript-language-server"
      }
    }
  }
}
```

Overrides are read when a session starts cold, so an edit applies to the next workspace that has
no server running yet. Sessions already holding a binary keep it until they go idle.

## Why the first click is slow and the rest are not

A language server has to load the project before its answers mean anything. tsserver on a large
monorepo takes several seconds, and during that window it answers `textDocument/definition` with a
**well-formed wrong result**: the target is the import statement you clicked, not the declaration.
No error, no warning.

Paseo gates every request on the document's first `publishDiagnostics`, which is the boundary where
that server's answers become correct. The wait is bounded rather than required, because servers
using pull diagnostics never send it.

The underline appears on the word under the pointer before the daemon has answered, and the
server's own range replaces it when the answer arrives. Waiting for the round trip first made a
warm server feel sluggish and a cold one feel broken. A word that resolves to nothing loses its
underline, and results are cached per word so a second hover costs nothing.

The hover issues the same request as the click, so by the time you press the mouse the project is
usually loaded and the jump is instant. While a click waits on a cold server the cursor shows
progress.

A target that encloses the position you clicked is dropped. tsserver answers a click on `return`
or `export` with the function containing it, and linking every keyword to the block you are
already inside is noise. The cost is that a recursive call resolves to nothing, since its
declaration also encloses it.

Go to definition is off while a file has unsaved edits. The daemon resolves against the file on
disk, so positions from a modified buffer would land somewhere else in the server's copy. Save and
the links come back.

One server runs per (workspace root, language), started on first use and stopped after ten idle
minutes or when a fifth would be needed — a loaded project graph is the expensive thing it holds,
and Paseo hands out a worktree per agent.

The daemon compares the file's size and mtime before reading it, so repeated requests against an
unchanged file cost neither a disk read nor a document sync.

## Scope

Web and desktop. Native has no pointer to hold a modifier over, so the file viewer there is
unchanged.

Only `code.definition` is implemented. Hover, references, and document symbols reuse the same
session and are additive; see `packages/server/src/server/lsp/`.

Clients gate on `server_info.features.codeNavigation`, so an older daemon simply renders no
affordance. Targets outside the workspace root are dropped rather than sent, because the client
cannot open them and the path would leak a location from outside the workspace.
