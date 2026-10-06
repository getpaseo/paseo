---
title: Publish a plugin
description: Share a Paseo plugin on npm, through a private registry, or from a Git repository.
nav: Publishing
order: 45
category: Plugins
---

# Publish a plugin

Publish your plugin so other people can install and use it in Paseo. Start with a working
[plugin project](/docs/plugins), then choose where to share it:

- [Plugin registry](#plugin-registry): share a reviewed artifact users install by `owner/slug`.
- [npm](#publish-on-npm): publish a package on the public npm registry.
- [GitHub or Git](#share-through-github-or-git): let users install from a repository.

## Plugin registry

Browse published plugins at [paseo.sh/plugins](https://paseo.sh/plugins).
Users install the reviewed artifact with:

```bash
paseo plugin add owner/slug
```

Publish your artifact through npm or Git, then follow the
[registry submission guide](https://github.com/getpaseo/plugins) to submit it for review.
Registry installations and updates use the approved revision and plugin path.
Direct Git installs use explicit `git:owner/repository` shorthand or a full Git URL.

## Publish on npm

The scaffold prepares the package files and development dependencies. You choose the package name
and release version.

### 1. Set your package name and version

From the plugin directory, set your package details and allow publication. Replace `@acme` with your npm scope:

```bash
npm pkg set name=@acme/paseo-review version=1.0.0
npm pkg delete private
```

### 2. Check and publish

```bash
npm run typecheck
npm pack --dry-run
npm publish --access public
```

Check the pack output includes any assets you added to the project.

### 3. Test the published plugin

On a daemon host with npm available:

```bash
paseo plugin install npm:@acme/paseo-review@1.0.0
```

Users can also paste `npm:@acme/paseo-review` into **Settings → Plugins → Plugin source**.

:::example[Package configuration]

The scaffold includes this `files` list in `package.json`:

```json
{
  "files": [
    "paseo-plugin.json",
    "OVERVIEW.md",
    "index.client.ts",
    "index.client.tsx",
    "index.server.ts",
    "index.server.tsx",
    "client/",
    "server/",
    "shared/"
  ]
}
```

- Add any assets stored outside these directories to `files`.
- Keep the scaffold's SDK and host libraries in `devDependencies`.
- Add other runtime libraries with `npm install <package>`. Paseo installs their dependencies too.
- The npm package name identifies the source. The manifest's `id` identifies the installed plugin.

See the [project reference](/docs/plugins/reference#project-files) for entry points and runtime boundaries.

:::

### Plugins with a build step

Paseo compiles TypeScript. An ordinary plugin needs no separate build before publication.
If your plugin generates files, include the generated output in the package.

**Installation scripts do not run automatically.** If a dependency needs host-specific setup,
declare a [preparation command](/docs/plugins/reference#cli-reference).

:::example[Generated files and dependencies]

- Generate code and assets before running `npm publish`.
- Keep generated JavaScript in its runtime directory and import it from the TypeScript entry.
- Include generated assets in `files`.
- Keep host-provided modules external when producing your own bundle.
- Remove Git-only dependency-install commands from the published manifest; npm installation already
  installs production dependencies.

Paseo skips npm lifecycle scripts during installation, including dependency scripts. For example,
a native dependency that needs rebuilding requires an explicit preparation command.

:::

:::example[Publish a private package with GitHub Packages]

You can publish a company plugin to GitHub Packages. Follow the npm steps above, using your
organization's scope, and replace the publish command with:

```bash
npm publish --registry=https://npm.pkg.github.com
```

[Configure GitHub authentication and package access](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
before publishing.

To install the plugin, configure npm **on the daemon host, as the user running Paseo**:

1. Add your organization's registry to `~/.npmrc`:

   ```ini
   @acme:registry=https://npm.pkg.github.com
   ```

2. Log in with your GitHub username and a personal access token (classic) as the password.
   The token needs `read:packages` and access to the package.

   ```bash
   npm login --scope=@acme --auth-type=legacy --registry=https://npm.pkg.github.com
   ```

3. Install the plugin:

   ```bash
   paseo plugin install npm:@acme/paseo-review
   ```

Paseo uses the host's npm registry settings and credentials for installation and updates.
In the app, enter only the source identifier.

:::

## Icons and screenshots

Declare your display name, icon, screenshots, and demo videos in `paseo-plugin.json`:

```json
{
  "id": "review-tools",
  "name": "Review tools",
  "description": "Reviews changes before merge",
  "icon": "assets/icon.png",
  "media": ["assets/screenshot.png", "https://example.com/review-demo.mp4"],
  "requirements": { "paseo": ">=0.11.0" }
}
```

All three fields are optional. `name` gives the registry and website a display name without
changing the installation ID. When omitted, the registry falls back to a humanized ID.
`icon` must point to a PNG inside the plugin package. `media` accepts paths to images and videos
inside the package or HTTPS URLs, in display order. Paths are relative to the manifest; use
forward slashes and keep them inside the package. See the [manifest reference](/docs/plugins/reference#project-files)
for validation rules.

Commit local assets alongside the manifest at the pinned revision. For npm, add their directory
(for example, `assets/`) to `package.json`'s `files` list and verify it with `npm pack --dry-run`.
The scaffold documents these fields in its manifest's `$comment`; replace the display name and
add your own assets before publishing.

Manifests using these fields fail to install on daemons before 0.11.0. Set
`requirements.paseo` to `>=0.11.0` or a narrower supported range.

## Your listing page

Write `OVERVIEW.md` beside `paseo-plugin.json` for the plugin page inside Paseo.
It helps someone decide whether to install your plugin; the install command is already at
the top of that page. A README assumes a GitHub audience and carries installation
instructions, technical details, and badges. Long, AI-generated READMEs make people read
past that material to understand what a plugin does.

`OVERVIEW.md` is required to list your plugin in the registry. Commit it beside
`paseo-plugin.json` in the source repository at the pinned commit. The registry resolves it
relative to the manifest, under `pluginPath` for monorepos. Include it in the published npm
package too; the scaffold's `files` list includes it. Replace the scaffold's guidance comment
with useful facts before publishing.

The repository overview takes precedence over a registry import stopgap. Online validation
fails when the pinned commit has no `OVERVIEW.md`, except for unchanged imported records
that already carry `plugins/<owner>/<slug>.md` in the registry repository. Every version bump
requires a repository overview and removes the stopgap in the same PR. A bump without the
repository overview fails validation. README files do not supply the overview.

Author overviews and registry stopgaps follow the same content contract, in this order.
Choose headings only when they help; length follows complexity. A theme needs one paragraph.

1. Explain what the plugin is and does in plain terms first.
2. Explain how it works only when that is not obvious.
3. Explain setup when needed: settings, accounts, tokens, providers, external tools, or other
   plugins. Include applicable daemon version and operating system requirements. Setup
   guidance is allowed; installation instructions are not.
4. Explain capabilities and settings worth understanding, what each option does, what the
   plugin reads or sends and where, permissions, and known limits.

Use sentence case and plain factual language, with no em dashes. Omit installation commands,
badges, changelog, contributing or license sections, marketing, and unsupported claims.
Avoid implementation filler such as empty cleanup functions, catalogs of theme-token fields,
or lists of absent features. Keep only what helps someone choose the plugin.

If your plugin is an unchanged imported record, you can propose an author-written overview
to replace the registry stopgap. Do not add import credit to your own `OVERVIEW.md`.

## Share through GitHub or Git

Push the plugin project to a repository. Users can install it with:

```bash
paseo plugin add git:acme/paseo-review
```

For another Git host:

```bash
paseo plugin install git:https://git.example.com/acme/paseo-review.git
```

If your plugin has runtime npm dependencies, commit `package-lock.json` and add a preparation
command to `paseo-plugin.json`:

```json
{
  "build": [["npm", "ci", "--omit=dev"]]
}
```

- `npm ci` installs the versions in the committed lockfile.
- `--omit=dev` excludes development tools.
- npm must be available on the daemon host.

Plugins that only use Paseo's host libraries need no preparation command.
