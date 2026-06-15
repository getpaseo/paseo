import type { GitHubSearchItem } from "@getpaseo/protocol/messages";
import type { ComboboxOption as ComboboxOptionType } from "@/components/ui/combobox";
import type { PickerItem } from "./new-workspace-picker-item";

export interface PickerOptionData {
  options: ComboboxOptionType[];
  itemById: Map<string, PickerItem>;
}

export interface PickerItemLabels {
  newBranch: string;
}

export const NEW_BRANCH_OPTION_ID = "new-branch";
export const BRANCH_OPTION_PREFIX = "branch:";
export const PR_OPTION_PREFIX = "github-pr:";

export function branchOptionId(name: string): string {
  return `${BRANCH_OPTION_PREFIX}${name}`;
}

export function prOptionId(number: number): string {
  return `${PR_OPTION_PREFIX}${number}`;
}

function formatPrLabel(item: { number: number; title: string }): string {
  return `#${item.number} ${item.title}`;
}

export function pickerItemLabel(item: PickerItem, labels: PickerItemLabels): string {
  if (item.kind === "new-branch") {
    return labels.newBranch;
  }
  return item.kind === "branch" ? item.name : formatPrLabel(item.item);
}

export function pickerItemTriggerLabel(item: PickerItem, labels: PickerItemLabels): string {
  return pickerItemLabel(item, labels);
}

export function pickerItemOptionId(item: PickerItem): string {
  switch (item.kind) {
    case "new-branch":
      return NEW_BRANCH_OPTION_ID;
    case "branch":
      return branchOptionId(item.name);
    case "github-pr":
      return prOptionId(item.item.number);
  }
}

export function computePickerOptionData(input: {
  branchDetails: ReadonlyArray<{ name: string; committerDate: number }>;
  prItems: ReadonlyArray<GitHubSearchItem>;
  newBranchLabel: string;
}): PickerOptionData {
  const idMap = new Map<string, PickerItem>([[NEW_BRANCH_OPTION_ID, { kind: "new-branch" }]]);

  interface TimedOption {
    option: ComboboxOptionType;
    timestamp: number;
  }
  const timedOptions: TimedOption[] = [];

  for (const branch of input.branchDetails) {
    const id = branchOptionId(branch.name);
    const option = { id, label: branch.name };
    idMap.set(id, { kind: "branch", name: branch.name });
    timedOptions.push({ option, timestamp: branch.committerDate });
  }

  for (const pr of input.prItems) {
    if (!pr.headRefName) continue;
    const id = prOptionId(pr.number);
    const option = { id, label: formatPrLabel(pr) };
    idMap.set(id, { kind: "github-pr", item: pr });
    const updatedAtMs = pr.updatedAt ? Date.parse(pr.updatedAt) : 0;
    const timestamp = Number.isNaN(updatedAtMs) ? 0 : Math.floor(updatedAtMs / 1000);
    timedOptions.push({ option, timestamp });
  }

  timedOptions.sort((a, b) => b.timestamp - a.timestamp);
  return {
    options: [
      { id: NEW_BRANCH_OPTION_ID, label: input.newBranchLabel },
      ...timedOptions.map((entry) => entry.option),
    ],
    itemById: idMap,
  };
}
