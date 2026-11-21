import { SPACING } from "@/styles/theme";

export const CHAT_COLUMN_BASE_GUTTER = SPACING[4];

export interface ChatColumnGutters {
  paddingLeft: number;
  paddingRight: number | string;
}

/**
 * Horizontal padding for a chat column on web.
 *
 * When the chat outline reserves `outlineInset` on the left, a capped column matches
 * that inset on the right using only the horizontal slack left over after fitting
 * `contentMaxWidth`. Default and Wide stay centered while the pane has room, shift
 * smoothly away from the outline as the pane narrows, and fall back to the base gutter
 * on the right when uncapped (`Full`) or tight.
 */
export function resolveChatColumnGutters(input: {
  gutter: number;
  outlineInset: number;
  contentMaxWidth: number | undefined;
}): ChatColumnGutters {
  const paddingLeft = input.gutter + input.outlineInset;
  const paddingRight =
    input.outlineInset > 0 && input.contentMaxWidth !== undefined
      ? `clamp(${input.gutter}px, calc(100% - ${paddingLeft + input.contentMaxWidth}px), ${paddingLeft}px)`
      : input.gutter;
  return { paddingLeft, paddingRight };
}
