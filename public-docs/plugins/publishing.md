---
title: Publish a plugin
description: Prepare, publish and submit a Paseo plugin to the reviewed registry.
nav: Publishing
order: 45
category: Plugins
---

# Publish a plugin

Start with a working [plugin project](/docs/plugins). Prepare its listing, publish it on npm
or push it to GitHub, then submit it to the registry. After approval, users install the reviewed
version with `paseo plugin add owner/slug`.

1. Prepare your [listing page](#your-listing-page) and, for a visual plugin, an
   [interface image](#icons-and-screenshots).
2. [Publish on npm](#publish-on-npm) or [share through Git](#share-through-github-or-git).
3. [Submit to the plugin registry](#plugin-registry).

For a private plugin, use [direct Git installation](#share-through-github-or-git) or
[private npm packages](#private-npm-packages).

## Your listing page

You can submit without `OVERVIEW.md`; the reviewer creates a listing page from your README and
verified behavior. To maintain the page yourself, put `OVERVIEW.md` beside `paseo-plugin.json`
and include it in the published package. The scaffold already includes it in `files`.
Your shipped overview replaces the reviewer-written page.

Explain these points in order, using headings only when they help:

1. What the plugin does.
2. How it works, when that is not obvious.
3. Setup: settings, accounts, tokens, external tools, supported operating systems and Paseo versions.
4. Useful capabilities, settings, data access, permissions and limitations.

Describe where data goes, including prompts and tool results sent to agent providers. Local storage
does not mean data stays on the host. If the plugin downloads or installs software while running,
explain what it installs and its source, and require explicit user confirmation before the download.
This applies to activation and connection tests too; declining must leave the software uninstalled.

Use plain factual language and sentence case. Omit marketing, unsupported claims, badges,
changelogs, contributing and license sections, and implementation details that do not help someone
choose the plugin. The listing already provides plugin installation instructions.

The publication validator rejects `paseo plugin add`, `npm install` and `npm i` anywhere in an
overview, including development or setup examples. Link to your README for those commands.

Also supply a one-sentence description: use `package.json`'s `description` for npm or the manifest's
`description` for Git. The reviewer can fill in a missing description in the registry.

### Other languages

Listings show in English and Simplified Chinese. English is required and translations are optional.
Add a translated `name` and `description` to `paseo-plugin.json`, keyed by language tag:

```json
{
  "id": "review-tools",
  "name": "Review tools",
  "description": "Reviews changes before merge",
  "translations": {
    "zh-CN": { "name": "审查工具", "description": "在合并前审查改动" }
  }
}
```

Each field is optional, and a missing one shows the English text. The registry checks
`translations` when it publishes the plugin: keys are canonical language tags other than `en`, and
each value sets only `name` or `description`, as non-empty strings. Paseo itself does not read
`translations`, so a mistake there fails publication, not installation.

To translate the overview, publish a complete copy named for the language next to `OVERVIEW.md`,
such as `OVERVIEW.zh-CN.md`. The scaffold's `files` list already includes `OVERVIEW.*.md`. The
registry reads `OVERVIEW.<tag>.md` as a translation when the tag is a canonical language tag with a
two- or three-letter language code, other than `en`. It ignores other names, such as
`OVERVIEW.backup.md` or `OVERVIEW.zh-cn.md`. A three-letter name such as `OVERVIEW.old.md` counts as
a language, so do not use one for a non-translation. Readers in that language see the
translation; others see the English overview with a notice. The overview rules above apply to
translations, so update them when `OVERVIEW.md` changes. Reviewers can add or correct translations
in the registry.

## Icons and screenshots

Themes, panels and other visual plugin interfaces need at least one image showing the current
interface. Use sample data and hide private details. An icon alone does not meet this requirement;
plugins without their own visual interface do not need screenshots.

Declare local images in `paseo-plugin.json` before publishing:

```json
{
  "id": "review-tools",
  "name": "Review tools",
  "description": "Reviews changes before merge",
  "icon": "assets/icon.png",
  "media": ["assets/screenshot.png"],
  "requirements": { "paseo": ">=0.11.0" }
}
```

Create the referenced files and include `assets/` in `package.json`'s `files` list for npm.
Paths are relative to the manifest, use forward slashes and stay inside the plugin directory.
These metadata fields require Paseo 0.11.0 or later.

| Field   | Listing behavior                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`  | Optional display name; defaults to a humanized plugin ID.                                                                                                           |
| `icon`  | Optional package-relative PNG. Provider registration icons have a separate [SVG contract](/docs/plugins/reference#providers).                                       |
| `media` | Package-relative paths or public HTTPS URLs. Images: PNG, JPG, JPEG, WebP or GIF. Videos: MP4 or WebM. The first image is the card thumbnail; videos supplement it. |

Public media URLs need a supported file extension, matched case-insensitively, and must return
HTTP 200 with the corresponding image or video content type. SVG and extensionless attachment
URLs are not accepted as registry media.

Instead of declaring `media`, you can supply suitable public image URLs in the submission or
review PR. The reviewer can add them to the listing without a new plugin release.

## Publish on npm

### 1. Set package identity

Use an npm scope you can publish to and authenticate with `npm login`. From your plugin directory,
replace `@acme` and the repository below with your own values:

```bash
npm pkg set name=@acme/paseo-review version=1.0.0
npm pkg delete private
npm pkg set repository.type=git repository.url=git+https://github.com/acme/paseo-review.git
```

The current registry tooling requires a GitHub repository for npm listing ownership, supplied
through `package.json` or npm provenance. Set `repository` to your public source repository so
pinning can determine the listing owner. Provenance itself is optional; if present, its repository
must match the package's repository. A matching source checkout is not required for artifact review.

### 2. Lock installed dependencies

Keep Paseo's host libraries and type-only dependencies in `devDependencies`. Add other runtime
libraries to `dependencies`. For registry submission, every installed dependency tree needs a lock
with exact versions, resolved sources and integrity, including transitive dependencies.

For an npm package with installed runtime dependencies, update its lock without running lifecycle
scripts, then create the publishable lock:

```bash
npm install --package-lock-only --ignore-scripts
npm shrinkwrap
```

`npm shrinkwrap` converts `package-lock.json` into `npm-shrinkwrap.json`. npm publishes the shrinkwrap
at the package root; it does not publish `package-lock.json`. A repository-only lock or exact direct
version does not lock the dependency tree installed by your users.

Plugins using only host libraries and development dependencies need no runtime lock unless a
preparation command installs those dependencies. You can also bundle a library and remove the
runtime dependency declaration. See [preparation and additional setup](#plugins-with-a-build-step)
if your plugin installs a separate tree.

### 3. Check the package and publish

Generate any required files before checking the package; the dry run skips packing scripts.

```bash
npm run typecheck
npm pack --dry-run --ignore-scripts
```

Check the file list contains `paseo-plugin.json`, at least one runtime entry, every imported local
module, any overview and assets you declared, and the shrinkwrap when required. Repository-only import aliases
and files outside the package do not reach users. The scaffold includes the entries and `client/`,
`server/` and `shared/`; add other asset directories to `files`.

Confirm any declared preparation command succeeds with the Node/npm versions you support;
an out-of-sync or incompatible lockfile still blocks installation.

Publish the checked version:

```bash
npm publish --access public
```

On a test daemon, install that exact published version and exercise its contributions:

```bash
paseo plugin install npm:@acme/paseo-review@1.0.0
paseo plugin ls
```

Require `running` with no error, then [submit the package](#plugin-registry).

## Share through GitHub or Git

For the public registry, push your plugin to a public GitHub repository. Include its manifest,
runtime entries, imported files and listing assets. Git tags and commits are optional at submission;
provide one to select a revision, or the reviewer resolves `main`.

If preparation installs runtime npm dependencies, commit a synchronized `package-lock.json` and
add this command to `paseo-plugin.json`:

```json
{
  "build": [["npm", "ci", "--omit=dev", "--ignore-scripts"]]
}
```

`npm ci` consumes the committed lock and fails if it disagrees with `package.json`. `--omit=dev`
excludes development tools and `--ignore-scripts` suppresses dependency lifecycle scripts.
The daemon needs npm on its command path. Plugins using only host libraries need no preparation
command. See [preparation](#plugins-with-a-build-step) for generated files or explicit scripts.

Users can install directly from Git without a registry listing:

```bash
paseo plugin add git:acme/paseo-review
paseo plugin add git:acme/monorepo:plugins/review
```

Use `--ref` to select a branch, tag or commit for the initial installation. Direct installation
also supports private repositories and other Git hosts when the daemon has access; see
[plugin sources](/docs/plugins/reference#plugin-sources). Registry submission accepts public
GitHub sources and public npm packages.

## Plugin registry

Open the [submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml).
Use the form so the issue receives the submission label that starts intake.

1. Use your plugin's name as the title.
2. In **Source**, enter the public npm package name or page, or the GitHub repository/folder URL.
   Include the version or Git reference if you want a specific release reviewed. npm defaults to
   `latest`. Registry IDs and local directories are not submission sources.
3. Select the categories that fit. Include any interface-image URLs in the issue description.

The bot opens a review PR. The reviewer inspects the artifact and dependencies without running
plugin code, completes the listing and records the exact approved version or commit. Publication
requires the [review policy](https://github.com/getpaseo/plugins/blob/main/REVIEW.md), including
locked installation inputs and appropriate data access, even when automated validation passes.

If a change is requested, reply on the review PR with the corrected version/revision or requested
image URL. The reviewer updates the pin and listing. Intake service errors retry automatically;
missing images or an overview do not prevent opening the review PR.

After approval and publication, users install your listing with:

```bash
paseo plugin add owner/slug
```

npm releases receive automatic update PRs. Submit Git updates manually with the desired revision.
Existing registry installations use approved pins; direct npm/Git installs follow their own update
rules in the [source reference](/docs/plugins/reference#plugin-sources).

## Plugins with a build step

Paseo compiles TypeScript, so an ordinary plugin needs no separate publication build.
Keep generated modules in their runtime directory and host-provided modules external.

Paseo suppresses npm lifecycle scripts during package acquisition. Commands explicitly declared in
manifest `build` still run, including scripts they invoke. Explain the purpose of those commands
and keep their inputs locked and inspectable. Remove Git-only dependency-install commands from
npm manifests when npm already installs the production dependencies.

Later setup that installs another dependency tree needs its own complete lock, even if your plugin
has a development lockfile. For npm setup, ship the runtime manifest and lock together and use
`npm ci`. For Python setup, ship a requirements file containing exact versions and SHA-256 hashes
for all transitive packages, then install it with:

```bash
python -m pip install --require-hashes -r requirements-documents.txt
```

This command rejects unpinned or unhashed dependencies. Runtime installation also needs the
[confirmation and disclosure](#your-listing-page) described above.

## Private npm packages

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
