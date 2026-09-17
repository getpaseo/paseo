---
title: Publish a plugin
description: Share a Paseo plugin on npm, through a private registry, or from a Git repository.
nav: Publishing
order: 45
category: Plugins
---

# Publish a plugin

Publish your plugin on npm so users can install it and its dependencies with one source identifier.
Start with a working [plugin project](/docs/plugins). npm is required on the daemon host for installation;
loading and reloading the installed plugin use its local files.

## Publish on npm

Give your `package.json` a unique package name and version, and include the plugin files in the
published package. For a plugin with both client and server entries, add these fields to the
scaffold's existing `package.json`:

```json
{
  "name": "@acme/paseo-review",
  "version": "1.0.0",
  "private": false,
  "files": [
    "paseo-plugin.json",
    "index.client.tsx",
    "index.server.ts",
    "client/",
    "server/",
    "shared/"
  ]
}
```

The scaffold sets `private: true`; change it to `false` to allow publication.
Replace `@acme` with your npm scope. Match the entry filenames to your project, and include any
additional assets your plugin reads. Keep the scaffold's development dependencies and scripts.
The package name identifies the npm source; `paseo-plugin.json` supplies the installed plugin ID.

From the plugin directory, check and publish:

```bash
npm run typecheck
npm pack --dry-run
npm publish --access public
```

Inspect the pack output for the manifest, entries, imported files, and assets before publishing.
Then test the published package through Paseo:

```bash
paseo plugin install npm:@acme/paseo-review@1.0.0
```

Users can paste `npm:@acme/paseo-review` into **Settings → Plugins → Plugin source** to install the
latest release. An explicit version selects that installation; it does not pin future updates.
See [source identifiers](/docs/plugins/reference#plugin-sources) for tags, ranges, and subdirectories.

### Dependencies and generated files

Put libraries your plugin needs at runtime in `dependencies`. Paseo uses npm to install those
libraries and their transitive dependencies. Development dependencies are omitted and automatic
peer dependency installation is disabled. Keep Paseo's host modules—the plugin SDK, React, React
Native, TanStack Query, and Zod—in `devDependencies` for authoring; Paseo supplies their runtime
instances. Declare other required peer modules as dependencies.

Paseo compiles TypeScript and bundles imports separately for the client and server. You do not need
to precompile or bundle an ordinary TypeScript plugin. The entry names remain `index.client.ts`
or `.tsx` and `index.server.ts` or `.tsx`; at least one is required. npm's `main` and `exports`
fields do not select Paseo entries.

If your plugin generates code or assets, generate them before publishing and include the output
in `files`. Prebuilt JavaScript can live under `client/`, `server/`, or `shared/`, imported by the
normal TypeScript entry. Preserve the [runtime boundaries](/docs/plugins/reference#project-files)
and host module imports. Paseo still compiles the entries.

npm lifecycle scripts, including dependency `install`, `postinstall`, and `prepare` scripts, do not
run when Paseo acquires a package. Publish ready-to-use files where possible. If installation needs
host-specific preparation, such as rebuilding a native dependency, declare it in the manifest's
[`build` commands](/docs/plugins/reference#cli-reference). These commands run on installation and
update after the Paseo requirements check. An npm plugin does not need a build command to install
its ordinary dependencies.

## Use a private GitHub package

Paseo uses the daemon user's npm configuration and environment for registries and authentication.
For a company plugin, publish a scoped package such as `@acme/paseo-review` to GitHub Packages.
Add the repository and publication registry to its `package.json`:

```json
{
  "name": "@acme/paseo-review",
  "repository": {
    "type": "git",
    "url": "https://github.com/acme/paseo-review.git"
  },
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  }
}
```

Authenticate with GitHub Packages and run `npm publish` from the plugin directory. Follow
[GitHub's npm registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
for publishing credentials and package access permissions.

To install the private package, configure npm **on the daemon host, as the user running Paseo**.
Add the scope mapping to that user's `~/.npmrc`:

```ini
@acme:registry=https://npm.pkg.github.com
```

Log in with a GitHub personal access token (classic) with `read:packages` and access to the package:

```bash
npm login --scope=@acme --auth-type=legacy --registry=https://npm.pkg.github.com
paseo plugin install npm:@acme/paseo-review
```

Use your GitHub username and the token as the password. Keep credentials on the daemon host;
enter only the source identifier in the app. Updates use the host's current npm configuration too.
Other npm-compatible registries use the same npm configuration mechanism.

## Share through GitHub or Git

You can also share a repository containing the plugin project:

```bash
paseo plugin install github:acme/paseo-review
paseo plugin install git:https://git.example.com/acme/paseo-review.git
```

For a plugin that only imports host modules, no preparation is needed. If it has runtime npm
dependencies, commit `package.json` and `package-lock.json`, then add this to `paseo-plugin.json`:

```json
{
  "id": "paseo-review",
  "requirements": { "paseo": ">=0.8.0" },
  "build": [["npm", "ci", "--omit=dev"]]
}
```

`npm ci` installs from the committed lockfile and fails if it disagrees with `package.json`.
`--omit=dev` leaves authoring tools out of the installation. Paseo runs the command in the plugin
directory on the daemon host, where npm must be on `PATH`. Git installation does not infer this
command from the presence of a package file.

If additional preparation needs development tools, `--omit=dev` will not install those tools.
Prefer generating and publishing the required files on npm. If you distribute the same project on
npm and Git, omit the dependency-install build command from the published manifest: npm acquisition
already installs production dependencies.

Set `requirements.paseo` to the earliest release whose APIs your plugin uses. `>=0.8.0` permits
compatible later releases, including 0.9; add an upper bound only for a known incompatibility.
See [requirements](/docs/plugins/reference#requirements).
