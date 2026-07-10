import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/stores/panel-store";

const MIN_CHAT_WIDTH = 400;

export function resolveDesktopSidebarWidth(input: {
  requestedWidth: number;
  viewportWidth: number;
}): number {
  "worklet";
  const maxWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, input.viewportWidth - MIN_CHAT_WIDTH),
  );
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, input.requestedWidth));
}
