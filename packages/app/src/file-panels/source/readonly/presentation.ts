export const SOURCE_PRESENTATION_BUDGETS = {
  web: { highlighted: 10 * 1024 * 1024, plain: 50 * 1024 * 1024 },
  native: { highlighted: 1024 * 1024, plain: 10 * 1024 * 1024 },
} as const;

export type SourcePresentation = "highlighted" | "plain" | "unsupported";
export type SourcePlatform = keyof typeof SOURCE_PRESENTATION_BUDGETS;

export function selectSourcePresentation(input: {
  size: number;
  platform: SourcePlatform;
}): SourcePresentation {
  const budgets = SOURCE_PRESENTATION_BUDGETS[input.platform];
  if (input.size <= budgets.highlighted) return "highlighted";
  if (input.size <= budgets.plain) return "plain";
  return "unsupported";
}
