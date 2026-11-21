## Publishing a listing

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

See [Your listing page](https://paseo.sh/docs/plugins/publishing.md#your-listing-page).
