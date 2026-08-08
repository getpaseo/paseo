# Hello Paseo

An example plugin contributing both kinds of contribution point: a file preview (line-numbered text, with clickable line numbers that ask the host to open the file at that line) and a sidebar panel (a pet).

Read [docs/plugins.md](../../../docs/plugins.md) for the contract. This directory is what it describes: a manifest plus one self-contained HTML file per contribution, no build step.

## Install it by hand

```bash
cp -r examples/plugins/hello-paseo "${PASEO_HOME:-$HOME/.paseo}/plugins/"
paseo plugin ls
```

`paseo plugin ls` rescans the directory, so you do not need to restart the daemon. Editing a `.html` file and reopening the preview picks up the change.

Try it on any `.txt` file, and find the pet next to Changes, Files, and PR in the explorer sidebar.

## Install it from a local registry

Point the daemon at a `file://` index to exercise the download-and-verify path instead of the hand-copy path.

```bash
mkdir -p /tmp/paseo-registry/hello-paseo
cp examples/plugins/hello-paseo/*.html examples/plugins/hello-paseo/paseo-plugin.json /tmp/paseo-registry/hello-paseo/
sha256sum /tmp/paseo-registry/hello-paseo/*   # shasum -a 256 on macOS
wc -c /tmp/paseo-registry/hello-paseo/*
```

Write `/tmp/paseo-registry/index.json` with those hashes and byte counts:

```json
{
  "version": 1,
  "plugins": [
    {
      "manifest": {
        "id": "hello-paseo",
        "name": "Hello Paseo",
        "version": "1.0.0",
        "description": "Example plugin: a line-numbered text preview and a sidebar pet.",
        "author": "Paseo",
        "license": "MIT",
        "contributes": {
          "filePreviews": [
            {
              "id": "lines",
              "title": "Lines",
              "extensions": [".hello", ".txt"],
              "entry": "preview.html"
            }
          ],
          "sidebarPanels": [{ "id": "pet", "title": "Pet", "icon": "cat", "entry": "pet.html" }]
        }
      },
      "files": [
        {
          "name": "paseo-plugin.json",
          "url": "file:///tmp/paseo-registry/hello-paseo/paseo-plugin.json",
          "sha256": "<sha256 of paseo-plugin.json>",
          "bytes": 0
        },
        {
          "name": "preview.html",
          "url": "file:///tmp/paseo-registry/hello-paseo/preview.html",
          "sha256": "<sha256 of preview.html>",
          "bytes": 0
        },
        {
          "name": "pet.html",
          "url": "file:///tmp/paseo-registry/hello-paseo/pet.html",
          "sha256": "<sha256 of pet.html>",
          "bytes": 0
        }
      ]
    }
  ]
}
```

Set `daemon.plugins.registryUrl` to `file:///tmp/paseo-registry/index.json` in `$PASEO_HOME/config.json`, restart the daemon, then:

```bash
paseo plugin browse
paseo plugin install hello-paseo
```

A wrong `sha256` fails the install with a non-zero exit — worth breaking one on purpose once to see it.

## Copy it

Change `id` in `paseo-plugin.json` (it is also the directory name), rename the directory to match, and edit the HTML. Add `paseoVersion` if your plugin needs a daemon feature that shipped in a specific release; this example omits it because it only uses the original bridge.
