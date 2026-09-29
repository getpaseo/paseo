export interface TabGroupInput {
  key: string;
  title: string;
  isActive: boolean;
  labels: Record<string, string> | null;
}

export interface TabGroupInfo {
  groupKey: string;
  label: string;
  colorIndex: number;
  collapsed: boolean;
  /** Tabs of a collapsed group hidden behind this one. */
  hiddenCount: number;
}

export interface TabGrouping {
  /** Tab keys in display order, hidden tabs left out. */
  visibleKeys: string[];
  /** Every tab key in grouped order, for writing a reorder back without losing hidden tabs. */
  orderedKeys: string[];
  infoByKey: Map<string, TabGroupInfo>;
}

export const TAB_GROUP_COLOR_COUNT = 6;
const ISSUE_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;

function groupKeyOf(labels: Record<string, string> | null): string | null {
  if (!labels) return null;
  const feature = labels["paperclip.feature"] ?? labels["paperclip.issue"];
  return feature ? `paperclip:${feature}` : null;
}

function groupLabelOf(member: TabGroupInput): string {
  const key = member.labels?.["paperclip.feature.key"] ?? ISSUE_KEY.exec(member.title)?.[0];
  const title = member.labels?.["paperclip.feature.title"];
  return [key, title].filter(Boolean).join(" · ") || "Paperclip";
}

function colorIndexOf(groupKey: string): number {
  let hash = 0;
  for (const char of groupKey) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % TAB_GROUP_COLOR_COUNT;
}

/**
 * Paperclip tabs of one feature sit together, groups in the order of their first tab and every
 * other tab after them. A collapsed group shows one tab, the active one when it is in there.
 */
export function groupWorkspaceTabs(input: {
  tabs: readonly TabGroupInput[];
  collapsedGroups: ReadonlySet<string>;
}): TabGrouping {
  const members = new Map<string, TabGroupInput[]>();
  const ungrouped: string[] = [];
  for (const tab of input.tabs) {
    const groupKey = groupKeyOf(tab.labels);
    if (!groupKey) {
      ungrouped.push(tab.key);
      continue;
    }
    const list = members.get(groupKey) ?? [];
    list.push(tab);
    members.set(groupKey, list);
  }
  const allKeys = input.tabs.map((tab) => tab.key);
  if (members.size === 0) {
    return { visibleKeys: allKeys, orderedKeys: allKeys, infoByKey: new Map() };
  }

  const visibleKeys: string[] = [];
  const orderedKeys: string[] = [];
  const infoByKey = new Map<string, TabGroupInfo>();
  for (const [groupKey, group] of members) {
    const collapsed = input.collapsedGroups.has(groupKey);
    const representative = group.find((tab) => tab.isActive) ?? group[0]!;
    const label = groupLabelOf(group[0]!);
    const colorIndex = colorIndexOf(groupKey);
    for (const tab of group) {
      orderedKeys.push(tab.key);
      const shown = !collapsed || tab === representative;
      if (shown) visibleKeys.push(tab.key);
      infoByKey.set(tab.key, {
        groupKey,
        label,
        colorIndex,
        collapsed,
        hiddenCount: collapsed && tab === representative ? group.length - 1 : 0,
      });
    }
  }
  visibleKeys.push(...ungrouped);
  orderedKeys.push(...ungrouped);
  return { visibleKeys, orderedKeys, infoByKey };
}
