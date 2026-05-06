import type { WorkspaceDescriptor } from "@/stores/session-store";

export type WorkspaceHeaderCheckoutState =
  | { kind: "pending" }
  | { kind: "error" }
  | { kind: "ready"; checkout: { isGit: boolean; currentBranch: string | null } };

type WorkspaceHeaderRenderState =
  | { kind: "skeleton" }
  | {
      kind: "ready";
      title: string;
      subtitle: string;
      shouldShowSubtitle: boolean;
      isGitCheckout: boolean;
      currentBranchName: string | null;
    };

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function areHeaderLabelsEquivalent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const normalizedA = trimNonEmpty(a)?.toLocaleLowerCase();
  const normalizedB = trimNonEmpty(b)?.toLocaleLowerCase();
  if (!normalizedA || !normalizedB) {
    return false;
  }
  return normalizedA === normalizedB;
}

export function resolveWorkspaceHeader(input: { workspace: WorkspaceDescriptor }): {
  title: string;
  subtitle: string;
} {
  return {
    title: input.workspace.name,
    subtitle: input.workspace.projectDisplayName,
  };
}

export function resolveWorkspaceHeaderRenderState(input: {
  workspace: WorkspaceDescriptor | null;
  checkoutState: WorkspaceHeaderCheckoutState;
}): WorkspaceHeaderRenderState {
  if (!input.workspace) {
    return { kind: "skeleton" };
  }

  if (input.checkoutState.kind === "pending" && input.workspace.projectKind === "git") {
    return { kind: "skeleton" };
  }

  const header = resolveWorkspaceHeader({ workspace: input.workspace });
  const checkout = input.checkoutState.kind === "ready" ? input.checkoutState.checkout : null;
  const currentBranchName =
    checkout?.isGit && checkout.currentBranch !== "HEAD"
      ? trimNonEmpty(checkout.currentBranch)
      : null;

  return {
    kind: "ready",
    title: header.title,
    subtitle: header.subtitle,
    shouldShowSubtitle: !areHeaderLabelsEquivalent(header.title, header.subtitle),
    isGitCheckout: checkout?.isGit ?? false,
    currentBranchName,
  };
}

export function shouldRenderMissingWorkspaceDescriptor(input: {
  workspace: WorkspaceDescriptor | null;
  hasHydratedWorkspaces: boolean;
}): boolean {
  return !input.workspace && input.hasHydratedWorkspaces;
}
