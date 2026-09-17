/**
 * What's new: the release notes, read from the repository's CHANGELOG.md and
 * rendered in the app instead of sending the reader to a browser.
 *
 * Two things leave this module — the host the app shell mounts, and the command
 * every entry point calls. Where the document comes from, how it is parsed, and
 * how much of it renders at once stay inside; import from `@/changelog`, never
 * a path within it.
 */
export { ChangelogHost } from "./changelog-host";
export { openChangelog } from "./open-changelog";
