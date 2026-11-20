import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { StreamedText } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { z } from "zod";

export const inlineThinkingSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
});

type InlineThinkingData = z.output<typeof inlineThinkingSchema>;

export function InlineThinking({ item, theme }: PluginTimelineItemProps<InlineThinkingData>) {
  const style = useMemo(
    () => ({ color: theme.colors.foregroundMuted }),
    [theme.colors.foregroundMuted],
  );
  return <StreamedText text={item.data.text} phase={item.data.phase} style={style} />;
}
