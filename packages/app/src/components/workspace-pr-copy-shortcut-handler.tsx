import { useGlobalWorkspaceCopyPrAction } from "@/hooks/use-global-workspace-copy-pr-action";

// Headless host for the copy-change-request-link shortcut. The hook subscribes to the active
// workspace's githubRuntime, which ticks often, so it lives in its own component rather than
// the root layout — same reasoning as the pin shortcut host.
export function WorkspacePrCopyShortcutHandler() {
  useGlobalWorkspaceCopyPrAction();
  return null;
}
