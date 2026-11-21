import type { Theme } from "@/styles/theme";

export const foregroundIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});

export const mutedIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export const extraMutedIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
});
