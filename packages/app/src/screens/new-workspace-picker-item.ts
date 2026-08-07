import type { CreatePaseoWorktreeInput } from "@getpaseo/client/internal/daemon-client";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { ComboboxOptionModel } from "@/components/ui/combobox-options";
import { getForgePresentation } from "@/git/forge";

export interface BranchPickerDetail {
  name: string;
  committerDate: number;
  hasLocal?: boolean;
  hasRemote?: boolean;
  localAhead?: number;
  localBehind?: number;
}

export type PickerItem =
  | {
      kind: "branch";
      name: string;
      refName: string;
      accessibilityLabel: string;
      divergenceLabel?: string;
      committerDate?: number;
    }
  | {
      kind: "github-pr";
      item: ForgeSearchItem;
    };

export type PickerCheckoutRequest = Pick<
  CreatePaseoWorktreeInput,
  "action" | "refName" | "checkoutSource" | "githubPrNumber"
>;

const BRANCH_OPTION_PREFIX = "branch:";
const PR_OPTION_PREFIX = "github-pr:";
const REMOTE_TRACKING_PREFIX = "refs/remotes/";

export function branchPickerOptionId(refName: string): string {
  return `${BRANCH_OPTION_PREFIX}${refName}`;
}

function divergenceLabel(ahead: number, behind: number): string | undefined {
  const parts = [ahead > 0 ? `+${ahead}` : null, behind > 0 ? `−${behind}` : null].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function commitCount(count: number): string {
  return `${count} ${count === 1 ? "commit" : "commits"}`;
}

function divergenceAccessibility(ahead: number, behind: number, counterpart: string): string {
  if (ahead === 0 && behind === 0) {
    return `up to date with ${counterpart}`;
  }
  if (ahead > 0 && behind > 0) {
    return `${commitCount(ahead)} ahead and ${behind} behind ${counterpart}`;
  }
  if (ahead > 0) {
    return `${commitCount(ahead)} ahead of ${counterpart}`;
  }
  return `${commitCount(behind)} behind ${counterpart}`;
}

export function buildBranchPickerItems(details: readonly BranchPickerDetail[]): PickerItem[] {
  const items: PickerItem[] = [];

  for (const detail of details) {
    const hasKnownProvenance = detail.hasLocal !== undefined || detail.hasRemote !== undefined;
    if (!hasKnownProvenance) {
      items.push({
        kind: "branch",
        name: detail.name,
        refName: detail.name,
        accessibilityLabel: `${detail.name}, branch`,
        committerDate: detail.committerDate,
      });
      continue;
    }

    const hasLocal = detail.hasLocal === true;
    const hasRemote = detail.hasRemote === true;
    const localAhead = detail.localAhead;
    const localBehind = detail.localBehind;
    const hasDivergence =
      hasLocal && hasRemote && localAhead !== undefined && localBehind !== undefined;
    const refsDiffer = hasDivergence && (localAhead > 0 || localBehind > 0);
    // One row when the two refs point at the same commit, two rows when they differ or
    // when the divergence is unknown.
    const showsBothRefs = hasLocal && hasRemote && (!hasDivergence || refsDiffer);

    // The origin row goes first because it is the default base, and it never states
    // divergence: it is the reference point the local row is measured against.
    if (hasRemote) {
      items.push({
        kind: "branch",
        name: detail.name,
        refName: `refs/remotes/origin/${detail.name}`,
        accessibilityLabel: `${detail.name}, origin branch`,
        committerDate: detail.committerDate,
      });
    }

    if (hasLocal && (showsBothRefs || !hasRemote)) {
      const localItem: Extract<PickerItem, { kind: "branch" }> = {
        kind: "branch",
        name: showsBothRefs ? `${detail.name} (local)` : detail.name,
        refName: `refs/heads/${detail.name}`,
        accessibilityLabel: `${detail.name}, local branch`,
        committerDate: detail.committerDate,
      };
      if (hasDivergence) {
        localItem.divergenceLabel = divergenceLabel(localAhead, localBehind);
        localItem.accessibilityLabel += `, ${divergenceAccessibility(
          localAhead,
          localBehind,
          `origin ${detail.name}`,
        )}`;
      }
      items.push(localItem);
    }
  }

  return items;
}

export interface BaseRefCheckoutStatus {
  currentBranch: string | null;
  upstreamRef?: string | null;
}

// Display only. The exact ref is what every request carries; this is just how a ref reads in
// a row label, so "refs/remotes/origin/other-name" shows as "other-name".
function branchNameFromRef(refName: string): string {
  if (refName.startsWith("refs/heads/")) return refName.slice("refs/heads/".length);
  if (refName.startsWith(REMOTE_TRACKING_PREFIX)) {
    const remainder = refName.slice(REMOTE_TRACKING_PREFIX.length);
    const separator = remainder.indexOf("/");
    return separator === -1 ? remainder : remainder.slice(separator + 1);
  }
  return refName;
}

// Where a ref lives, for disambiguating two rows that would otherwise read the same.
function refQualifier(refName: string): string | null {
  if (refName.startsWith("refs/heads/")) return "local";
  if (refName.startsWith(REMOTE_TRACKING_PREFIX)) {
    const remainder = refName.slice(REMOTE_TRACKING_PREFIX.length);
    const separator = remainder.indexOf("/");
    return separator === -1 ? null : remainder.slice(0, separator);
  }
  return null;
}

// The one owner of "what do we branch off when the user picked nothing". The checkmarked
// row, the trigger label, and the created ref all read this; computing it twice is how the
// picker once showed local main while branching off something else.
//
// The upstream wins when the branch has one, because branching off the local ref silently
// carries unpushed commits into the new workspace. The daemon sends the resolved ref rather
// than a remote name, so a fork tracking upstream/main branches from upstream/main.
export function defaultBasePickerItem(status: BaseRefCheckoutStatus): PickerItem | null {
  const currentBranch = status.currentBranch;
  if (!currentBranch) return null;
  // COMPAT(checkoutUpstreamRef): added in v0.2.6, remove after 2027-02-01 once the daemon
  // floor sends upstreamRef. Daemons that predate it omit the field, which lands on the
  // local ref — the base those daemons always used.
  const refName = status.upstreamRef ?? `refs/heads/${currentBranch}`;
  // The upstream branch can be named differently from the local one, so the row reads the
  // ref rather than the branch the user happens to be on.
  const name = branchNameFromRef(refName);
  return {
    kind: "branch",
    name,
    refName,
    accessibilityLabel: status.upstreamRef ? `${name}, upstream branch` : `${name}, local branch`,
  };
}

export function pickerItemToCheckoutRequest(
  item: PickerItem | null,
): PickerCheckoutRequest | undefined {
  if (!item) return undefined;
  switch (item.kind) {
    case "branch":
      return { action: "branch-off", refName: item.refName };
    case "github-pr": {
      const headRefName = item.item.headRefName?.trim();
      const forge = item.item.forge ?? "github";
      return {
        action: "checkout",
        ...(headRefName ? { refName: headRefName } : {}),
        checkoutSource: {
          kind: "change_request",
          forge,
          number: item.item.number,
          ...(item.item.projectPath ? { projectPath: item.item.projectPath } : {}),
        },
        ...(forge === "github"
          ? {
              // COMPAT(githubPrNumber): added in v0.1.106, remove after 2026-12-28 once
              // daemon floor parses checkoutSource.
              githubPrNumber: item.item.number,
            }
          : {}),
      };
    }
  }
}

export function prPickerOptionId(number: number): string {
  return `${PR_OPTION_PREFIX}${number}`;
}

export function pickerOptionId(item: PickerItem): string {
  return item.kind === "branch"
    ? branchPickerOptionId(item.refName)
    : prPickerOptionId(item.item.number);
}

function formatPrLabel(item: Pick<ForgeSearchItem, "forge" | "number" | "title">): string {
  const presentation = getForgePresentation(item.forge ?? "github");
  return `${presentation.numberPrefix}${item.number} ${item.title}`;
}

export function pickerItemLabel(item: PickerItem): string {
  return item.kind === "branch" ? item.name : formatPrLabel(item.item);
}

export interface PickerOptionData {
  options: ComboboxOptionModel[];
  itemById: Map<string, PickerItem>;
  selectedOptionId: string;
}

interface TimedOption {
  option: ComboboxOptionModel;
  timestamp: number;
}

export function buildPickerOptionData(input: {
  branchDetails: readonly BranchPickerDetail[];
  prItems: readonly ForgeSearchItem[];
  baseItem: PickerItem | null;
}): PickerOptionData {
  const itemById = new Map<string, PickerItem>();
  const timedOptions: TimedOption[] = [];

  for (const branch of buildBranchPickerItems(input.branchDetails)) {
    if (branch.kind !== "branch") continue;
    const id = branchPickerOptionId(branch.refName);
    itemById.set(id, branch);
    timedOptions.push({
      option: { id, label: pickerItemLabel(branch) },
      timestamp: branch.committerDate ?? 0,
    });
  }

  for (const pr of input.prItems) {
    if (!pr.headRefName) continue;
    const id = prPickerOptionId(pr.number);
    itemById.set(id, { kind: "github-pr", item: pr });
    const updatedAtMs = pr.updatedAt ? Date.parse(pr.updatedAt) : 0;
    const timestamp = Number.isNaN(updatedAtMs) ? 0 : Math.floor(updatedAtMs / 1000);
    timedOptions.push({ option: { id, label: formatPrLabel(pr) }, timestamp });
  }

  const baseItem = input.baseItem;
  if (!baseItem) {
    timedOptions.sort((a, b) => b.timestamp - a.timestamp);
    return { options: timedOptions.map((t) => t.option), itemById, selectedOptionId: "" };
  }

  const selectedOptionId = pickerOptionId(baseItem);
  if (!itemById.has(selectedOptionId)) {
    // The label lives on the item, so the row and the trigger read it from the same place.
    const labeledItem = disambiguate(baseItem, timedOptions);
    itemById.set(selectedOptionId, labeledItem);
    timedOptions.push({
      option: { id: selectedOptionId, label: pickerItemLabel(labeledItem) },
      // The base sorts first: it is what a workspace is created from unless you pick something.
      timestamp: Number.POSITIVE_INFINITY,
    });
  }

  timedOptions.sort((a, b) => b.timestamp - a.timestamp);
  return { options: timedOptions.map((t) => t.option), itemById, selectedOptionId };
}

// Two rows reading "main" would be a coin flip for the user, so the added row says where its
// ref lives. Only when it collides — a lone row needs no qualifier.
function disambiguate(item: PickerItem, existing: readonly TimedOption[]): PickerItem {
  if (item.kind !== "branch") return item;
  if (!existing.some((entry) => entry.option.label === item.name)) return item;
  const qualifier = refQualifier(item.refName);
  if (!qualifier) return item;
  const name = `${item.name} (${qualifier})`;
  return {
    ...item,
    name,
    // Accessibility labels are built as `${name}${suffix}`, so re-prefixing keeps the spoken
    // label and the visible one the same string.
    accessibilityLabel: `${name}${item.accessibilityLabel.slice(item.name.length)}`,
  };
}
