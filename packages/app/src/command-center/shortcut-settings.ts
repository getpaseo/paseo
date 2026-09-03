import {
  getCommandShortcutBindingId,
  getCommandShortcutIdFromBindingId,
} from "@/keyboard/keyboard-shortcuts";
import type { CommandCenterContribution } from "./contributions";

export type CommandShortcutSettingsGroup = "models" | "thinking";

export interface CommandShortcutSettingsRow {
  shortcutId: string;
  bindingId: string;
  group: CommandShortcutSettingsGroup;
  label: string;
  combo: string | null | undefined;
  available: boolean;
}

function getGroup(shortcutId: string): CommandShortcutSettingsGroup | null {
  if (shortcutId.startsWith("models:")) return "models";
  if (shortcutId.startsWith("thinking:")) return "thinking";
  return null;
}

function fallbackLabel(shortcutId: string, group: CommandShortcutSettingsGroup): string {
  const target = shortcutId.slice(group.length + 1);
  if (group === "thinking") return target;
  const separator = target.indexOf(":");
  if (separator < 0) return target;
  return `${target.slice(0, separator)} · ${target.slice(separator + 1)}`;
}

function contributionLabel(contribution: CommandCenterContribution): string | null {
  if (contribution.presentation.kind !== "choice") return null;
  return contribution.presentation.path.slice(1).join(" · ");
}

function shortcutTargetId(shortcutId: string, group: CommandShortcutSettingsGroup): string {
  const target = shortcutId.slice(group.length + 1);
  if (group === "thinking") return target;
  const separator = target.indexOf(":");
  return separator < 0 ? target : target.slice(separator + 1);
}

// Availability comes from the sticky catalog, not the live contribution set: the
// settings route renders while the composer that registers agent-control
// contributions is unmounted, so the live set is always empty there.
export function buildCommandShortcutSettingsRows(
  catalog: readonly CommandCenterContribution[],
  overrides: Readonly<Record<string, string | null>>,
): CommandShortcutSettingsRow[] {
  const contributionsByShortcutId = new Map<string, CommandCenterContribution[]>();
  for (const contribution of catalog) {
    if (!contribution.shortcutId || !getGroup(contribution.shortcutId)) continue;
    const matches = contributionsByShortcutId.get(contribution.shortcutId) ?? [];
    matches.push(contribution);
    contributionsByShortcutId.set(contribution.shortcutId, matches);
  }

  const shortcutIds = new Set(contributionsByShortcutId.keys());
  for (const bindingId of Object.keys(overrides)) {
    const shortcutId = getCommandShortcutIdFromBindingId(bindingId);
    if (shortcutId && getGroup(shortcutId)) shortcutIds.add(shortcutId);
  }

  const rows = [...shortcutIds].flatMap((shortcutId) => {
    const group = getGroup(shortcutId);
    if (!group) return [];
    const matches = contributionsByShortcutId.get(shortcutId) ?? [];
    const bindingId = getCommandShortcutBindingId(shortcutId);
    return [
      {
        shortcutId,
        bindingId,
        group,
        label:
          (matches.length === 1 ? contributionLabel(matches[0]) : null) ??
          fallbackLabel(shortcutId, group),
        combo: overrides[bindingId],
        available: matches.length === 1,
      },
    ];
  });

  // Distinct targets can share a display label (e.g. two codex models both
  // labeled "GPT-5.6-Luna"); append the target id so the rows are tellable apart.
  const labelCounts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.group}:${row.label}`;
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  for (const row of rows) {
    if ((labelCounts.get(`${row.group}:${row.label}`) ?? 0) < 2) continue;
    row.label = `${row.label} (${shortcutTargetId(row.shortcutId, row.group)})`;
  }
  return rows;
}
