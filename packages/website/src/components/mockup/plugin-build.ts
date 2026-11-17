import { COMPOSER, script } from "./script";

const BUILD_REQUEST = "Build a release radar panel for merged PRs and failing checks.";
const CHANGE_REQUEST = "Show which check is failing.";

/**
 * The plugins scene: the user asks for a panel, the agent builds and installs a plugin, and the
 * panel opens. Then the user asks for a change and the open panel shows it.
 */
export const PLUGIN_BUILD = script([
  { kind: "wait", ms: 200 },
  { kind: "click", target: COMPOSER },
  { kind: "wait", ms: 250 },
  { kind: "type", text: BUILD_REQUEST },
  { kind: "user", text: BUILD_REQUEST },
  {
    kind: "agent",
    text: "I’ll scaffold a local plugin, add the explorer surface, and wire it into the sidebar.",
  },
  {
    kind: "tools",
    calls: [
      { kind: "read", detail: "paseo-plugin/SKILL.md" },
      { kind: "shell", detail: "paseo plugin init ~/dev/release-radar" },
      { kind: "write", detail: "~/dev/release-radar/release-radar.client.tsx" },
      { kind: "shell", detail: "paseo plugin install ~/dev/release-radar" },
    ],
  },
  { kind: "mark", name: "installed", ms: 500 },
  { kind: "agent", text: "Release Radar is live. It should now be visible in the right sidebar." },
  { kind: "turnEnd", worked: "2m 14s" },
  { kind: "wait", ms: 900 },
  { kind: "type", text: CHANGE_REQUEST },
  { kind: "user", text: CHANGE_REQUEST },
  {
    kind: "tools",
    calls: [
      { kind: "write", detail: "~/dev/release-radar/release-radar.client.tsx" },
      { kind: "shell", detail: "paseo plugin reload release-radar" },
    ],
  },
  { kind: "mark", name: "revised", ms: 500 },
  { kind: "agent", text: "Reloaded. The radar now lists the failing check under the tiles." },
  { kind: "turnEnd", worked: "19s" },
]);

/** Whether the plugin is installed: its panel is open and its item is in the sidebar. */
export function pluginInstalled(ms: number): boolean {
  return PLUGIN_BUILD.reached("installed", ms);
}

/** Whether the reloaded plugin lists the failing check. */
export function failingCheckListed(ms: number): boolean {
  return PLUGIN_BUILD.reached("revised", ms);
}
