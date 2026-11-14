import { useWorkspaceWidth } from "@/window-layout/workspace-width";

export function useWorkspaceViewport() {
  const { targetWidth } = useWorkspaceWidth();
  return { width: targetWidth, onLayout: undefined };
}
